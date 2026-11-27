import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Duplex, type Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SOURCE = resolve(__dirname, '../../../native/provider-exec/provider-exec.c')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function socket(stream: unknown): Duplex {
  if (!(stream instanceof Duplex)) {
    throw new Error('provider exec fd is not a socket')
  }
  return stream
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
    let exec: ChildProcess | undefined
    let outsider: ChildProcess | undefined

    // Signalled only through handles: a bare PID may already belong to another process. Every
    // process the CLI starts expires by itself if the watcher fails to stop it.
    afterEach(async () => {
      exec?.kill('SIGKILL')
      outsider?.kill('SIGKILL')
      await rm(dir, { recursive: true, force: true })
    })

    it('stops a tool that left the CLI session, and nothing it cannot prove is the chat’s', async () => {
      dir = await mkdtemp(join(tmpdir(), 'provider-exec-tree-'))
      const binary = join(dir, 'orca-provider-exec')
      execFileSync(process.platform === 'darwin' ? 'clang' : 'cc', [
        '-std=c11',
        '-O2',
        SOURCE,
        '-o',
        binary
      ])
      // The tool shell takes its own session and exits, orphaning a tagged tool and an untagged one.
      const tool = `echo $$ > ${dir}/s; '${process.execPath}' -e 'setTimeout(() => {}, 30000)' & echo $! > ${dir}/a; env -u ORCA_PROVIDER_TREE sleep 30 & echo $! > ${dir}/b`
      const cli = `require('child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(tool)}], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => {}, 30000)`
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
      const [owner, gate, status] = exec.stdio.slice(3, 6).map(socket)
      await readLine(status)
      gate.write('g\n')

      outsider = spawn('sleep', ['1000'], { detached: true, stdio: 'ignore' })
      await vi.waitFor(() => expect(readFileSync(join(dir, 'b'), 'utf8').trim()).not.toBe(''), {
        timeout: 5000
      })
      const tools = ['a', 'b'].map((name) => Number(readFileSync(join(dir, name), 'utf8')))
      expect(tools.every(alive)).toBe(true)
      // Only once the tool shell is gone are its tools orphans with no live ancestry.
      const shell = Number(readFileSync(join(dir, 's'), 'utf8'))
      await vi.waitFor(() => expect(alive(shell)).toBe(false), { timeout: 5000 })

      const completion = readLine(owner)
      owner.write('term\n')
      expect(await completion).toBe('group-absent')
      // A killed orphan stays a zombie until init reaps it.
      // Linux's subreaper proves the untagged orphan is the chat's. On macOS only the tag would,
      // and a tag never vouches for the rest of its session.
      const stopped = process.platform === 'darwin' ? [tools[0]] : tools
      await expect.poll(() => stopped.some(alive), { timeout: 2000 }).toBe(false)
      expect(alive(tools[1])).toBe(process.platform === 'darwin')
      expect(outsider.exitCode).toBeNull()
      expect(alive(outsider.pid!)).toBe(true)
    })
  }
)
