import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

const SOURCE = resolve(__dirname, '../../../native/provider-exec/provider-exec.c')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number): Promise<boolean> {
  // A killed orphan stays a zombie until init reaps it.
  for (let i = 0; i < 100 && alive(pid); i++) {
    await new Promise((done) => setTimeout(done, 20))
  }
  return !alive(pid)
}

function readLine(stream: Readable): Promise<string> {
  return new Promise((done, fail) => {
    let text = ''
    const onData = (chunk: Buffer): void => {
      text += chunk.toString()
      if (text.includes('\n')) {
        stream.off('data', onData)
        done(text.slice(0, text.indexOf('\n')))
      }
    }
    stream.on('data', onData)
    stream.once('error', fail)
  })
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'provider exec tree teardown',
  () => {
    let dir = ''
    const started: number[] = []
    let exec: ChildProcess | undefined

    afterEach(async () => {
      exec?.kill('SIGKILL')
      for (const pid of started) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      started.length = 0
      await rm(dir, { recursive: true, force: true })
    })

    it('stops a tool that left the CLI session, and nothing outside the tree', async () => {
      dir = await mkdtemp(join(tmpdir(), 'provider-exec-tree-'))
      const binary = join(dir, 'orca-provider-exec')
      execFileSync(process.platform === 'darwin' ? 'clang' : 'cc', [
        '-std=c11',
        '-O2',
        SOURCE,
        '-o',
        binary
      ])
      // The tool shell takes its own session and exits, orphaning a tagged tool and a SIP binary.
      const tool = `'${process.execPath}' -e 'setInterval(() => {}, 1000)' & echo $! > ${dir}/a; sleep 1000 & echo $! > ${dir}/b`
      const cli = `require('child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(tool)}], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000)`
      exec = spawn(
        binary,
        [
          '--cli-input-fd7',
          '1',
          '1000',
          'session',
          'stdin-end-and-sigterm',
          '--',
          process.execPath,
          '-e',
          cli
        ],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
        }
      )
      const [owner, gate, status] = exec.stdio.slice(3) as [Writable & Readable, Writable, Readable]
      const { leaderPid } = JSON.parse(await readLine(status)) as { leaderPid: number }
      started.push(leaderPid)
      gate.write('g\n')

      const outsider = spawn('sleep', ['1000'], { detached: true, stdio: 'ignore' })
      started.push(outsider.pid!)
      const written = (): boolean =>
        existsSync(join(dir, 'b')) && readFileSync(join(dir, 'b'), 'utf8').trim() !== ''
      for (let i = 0; i < 250 && !written(); i++) {
        await new Promise((done) => setTimeout(done, 20))
      }
      const tools = ['a', 'b'].map((name) => Number(readFileSync(join(dir, name), 'utf8')))
      started.push(...tools)
      expect(tools.every(alive)).toBe(true)

      const completion = readLine(owner)
      owner.write('term\n')
      expect(await completion).toBe('group-absent')
      expect(await gone(tools[0])).toBe(true)
      expect(await gone(tools[1])).toBe(true)
      expect(alive(outsider.pid!)).toBe(true)
    })
  }
)
