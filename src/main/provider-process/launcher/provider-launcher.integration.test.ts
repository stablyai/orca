import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Duplex, type Readable } from 'node:stream'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderOwnerListener } from '../provider-owner-channels'
import type { ProviderLauncherReply } from './provider-launcher-protocol'

const SOURCE = resolve(__dirname, '../../../../native/provider-exec/provider-exec.c')

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
    throw new Error('provider owner pipe is not a socket')
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
    // The rendezvous hands each pipe over paused, as the app's pipe adapter expects.
    stream.resume()
  })
}

/** Names the setup step that never settled, with what the launcher printed. */
function step<T>(name: string, promise: Promise<T>, stderr: () => string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(`${name} timed out; launcher: ${stderr()}`)), 8_000)
    })
  ]).finally(() => clearTimeout(timer))
}

// Linux only: the launcher exists so Electron main never forks there; macOS uses its terminal host.
describe.skipIf(process.platform !== 'linux')('provider launcher process', () => {
  let dir = ''
  let launcher: ChildProcess | undefined
  let cliPid = 0

  afterEach(async () => {
    launcher?.kill('SIGKILL')
    if (cliPid && alive(cliPid)) {
      process.kill(cliPid, 'SIGKILL')
    }
    cliPid = 0
    await rm(dir, { recursive: true, force: true })
  })

  async function launchChat(): Promise<{
    pipes: ReadonlyMap<number, Duplex>
    ownerPid: number
  }> {
    dir = await mkdtemp(join(tmpdir(), 'provider-launcher-'))
    const binary = join(dir, 'orca-provider-exec')
    execFileSync('cc', ['-std=c11', '-O2', SOURCE, '-o', binary])
    await build({
      entryPoints: [resolve(__dirname, 'provider-launcher-worker-entry.ts')],
      outfile: join(dir, 'launcher-worker.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    // A separate process hosting the real worker entry, as the utility process does.
    writeFileSync(
      join(dir, 'launcher.cjs'),
      `const { Worker } = require('node:worker_threads')
const worker = new Worker(${JSON.stringify(join(dir, 'launcher-worker.cjs'))})
worker.on('error', (error) => console.error('worker error', error))
worker.on('exit', (code) => console.error('worker exit', code))
process.on('message', (message) => worker.postMessage(message))
worker.on('message', (message) => process.send(message))`
    )
    launcher = fork(join(dir, 'launcher.cjs'), { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let launcherErr = ''
    launcher.stderr!.on('data', (chunk: Buffer) => (launcherErr += chunk.toString()))
    const err = (): string => launcherErr.slice(-2000)
    const listener = new ProviderOwnerListener()
    const path = await listener.listen()
    const cli = `require('fs').writeFileSync(${JSON.stringify(join(dir, 'cli'))}, String(process.pid)); setInterval(() => {}, 1000)`
    const reply = new Promise<ProviderLauncherReply>((done) => launcher!.once('message', done))
    launcher.send({
      id: 1,
      launch: {
        nonce: listener.nonce,
        path,
        program: binary,
        args: [
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
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', ELECTRON_RUN_AS_NODE: '1' }
      }
    })
    const answer = await step('launch reply', reply, err)
    if (!('result' in answer) || !('pid' in answer.result)) {
      throw new Error(`launch failed: ${JSON.stringify(answer)}`)
    }
    const pipes = new Map(
      [...(await step('owner pipes', listener.ready, err))].map(([fd, pipe]) => [fd, socket(pipe)])
    )
    for (const fd of [1, 2, 6, 7]) {
      pipes.get(fd)!.resume()
    }
    await step('bootstrap status', readLine(pipes.get(5)!), err)
    pipes.get(4)!.write('g\n')
    await vi.waitFor(() => {
      cliPid = Number(readFileSync(join(dir, 'cli'), 'utf8'))
      expect(cliPid).toBeGreaterThan(1)
    })
    return { pipes, ownerPid: answer.result.pid }
  }

  it('keeps a chat running when the launcher dies, and stops it on request', async () => {
    const { pipes, ownerPid } = await launchChat()
    launcher!.kill('SIGKILL')
    await vi.waitFor(() => expect(launcher!.signalCode).toBe('SIGKILL'))
    expect(alive(cliPid)).toBe(true)
    expect(alive(ownerPid)).toBe(true)
    const owner = pipes.get(3)!
    const completion = readLine(owner)
    owner.write('term\n')
    expect(await completion).toBe('group-absent')
    await vi.waitFor(() => expect(alive(cliPid)).toBe(false), { timeout: 5000 })
  })

  it('stops the chat when the app holding its pipes dies', async () => {
    const { pipes } = await launchChat()
    // The kernel closes every pipe end of a crashed or quit app exactly like this.
    for (const pipe of pipes.values()) {
      pipe.destroy()
    }
    await vi.waitFor(() => expect(alive(cliPid)).toBe(false), { timeout: 10_000 })
  })
})
