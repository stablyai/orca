import './mock-descendant-sweep'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import { HeadlessEmulator } from './headless-emulator'
import { spawnNativeDaemonPty } from './pty-subprocess/native-pty-spawn'
import { spawnBunPty } from './pty-subprocess/bun-pty-process-runtime'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'
import type {
  BunTerminal,
  BunTerminalOptions,
  BunRuntime
} from './pty-subprocess/bun-pty-process-contract'
import type { SubprocessHandle } from './session-subprocess-handle'

vi.mock('../pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups() {
    throw new Error('Use the fixture process kill')
  }
}))
vi.mock('./pty-subprocess/foreground-process-tracker', () => ({
  createPtyForegroundProcessTracker: () => ({
    recordOutput() {},
    markDead() {},
    getForegroundProcess: () => null
  })
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const hosts: TerminalHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()))
  vi.restoreAllMocks()
})

function fixture(historySeedChunks?: readonly string[]) {
  const receipt = deferred<void>()
  const started = deferred<void>()
  const exited = deferred<number>()
  let callbacks!: BunTerminalOptions
  const terminal: BunTerminal = {
    closed: false,
    write: () => 0,
    resize() {},
    close() {
      this.closed = true
      callbacks.exit?.(this, 0, null)
    }
  }
  const process = {
    pid: 4321,
    terminal,
    exited: exited.promise,
    kill: vi.fn(() => exited.resolve(1))
  }
  const runtime: BunRuntime = {
    Terminal: class {
      closed = false
      write = terminal.write
      resize = terminal.resize
      close = terminal.close
      constructor(options: BunTerminalOptions) {
        callbacks = options
        return terminal
      }
    },
    spawn: () => process
  }
  const pause = vi.fn(() => true)
  const host = new TerminalHost({
    spawnSubprocess: async (opts) => {
      let handle!: SubprocessHandle
      const spawned = await spawnNativeDaemonPty(
        {
          shellPath: '/bin/sh',
          shellArgs: [],
          spawnCwd: '/tmp',
          env: {},
          cols: opts.cols,
          rows: opts.rows,
          windowsFallbackAttempts: [],
          signal: opts.cancelSignal,
          onSpawnAttempt: (attempt, discardNative) => {
            handle = createDaemonPtySubprocessHandle({
              process: attempt.process,
              shellPath: attempt.shellPath,
              spawnCwd: '/tmp',
              env: {},
              startupCommandDeliveredInShellArgs: false,
              reportsChildExitStatus: true,
              sessionId: opts.sessionId,
              startupAgentRecognition: null
            })
            const discard = opts.onSpawnAttempt?.(() => handle, discardNative)
            started.resolve()
            return discard ?? { discard: async () => {} }
          }
        },
        {
          canUseBunPty: () => true,
          spawnBunPty: (args) =>
            spawnBunPty(args, {
              platform: 'win32',
              runtime,
              assignHostJob: () => true,
              createJob: () => ({
                terminate: () => {
                  exited.resolve(1)
                  return 'terminated'
                },
                close() {},
                pause,
                resume: () => true,
                listProcessIds: () => []
              }),
              createWindowsLaunch: () => ({
                command: [],
                env: {},
                clearCommand: [],
                windowsVerbatimArguments: false,
                release() {},
                dispose() {},
                readShellProcessId: () => 4322,
                waitForSpawn: () => receipt.promise
              })
            })
        }
      )
      expect(spawned.process.pid).toBe(4321)
      return handle
    }
  })
  hosts.push(host)
  const onData = vi.fn()
  const onExit = vi.fn()
  const controller = new AbortController()
  const pending = host.createOrAttach({
    historySeedChunks,
    sessionId: 'startup',
    cols: 80,
    rows: 24,
    command: 'after-confirmation',
    streamClient: { onData, onExit },
    cancelSignal: controller.signal,
    isCanceled: () => controller.signal.aborted
  })
  return {
    host,
    pending,
    onData,
    onExit,
    receipt,
    started,
    exited,
    terminal,
    pause,
    controller,
    emit(data: string) {
      const encoded = new TextEncoder().encode(data)
      for (let offset = 0; offset < encoded.length; offset += 16 * 1024) {
        callbacks.data(terminal, encoded.slice(offset, offset + 16 * 1024))
      }
    }
  }
}

it('parses and retains a startup prefix while the Windows receipt is pending', async () => {
  const f = fixture()
  await f.started.promise
  const output = `\x1b[?2004hSTART\r\n${'x'.repeat(1024 * 1024)}\r\nEND日本語🙂`
  f.emit(output)
  expect(f.onData).not.toHaveBeenCalled()
  expect(f.pause).not.toHaveBeenCalled()
  expect(f.host.listSessions()).toEqual([])
  f.receipt.resolve()
  const result = await f.pending
  expect(result).toMatchObject({ isNew: true, snapshot: null })
  expect(f.onData).toHaveBeenCalledWith(output, output.length, true, output.length)
  f.emit('NEXT')
  expect(f.onData.mock.calls.at(-1)?.[0]).toBe('NEXT')
  expect(f.host.getSnapshot('startup')?.modes.bracketedPaste).toBe(true)
})

it('bounds retained output while preserving early modes in the initial stream snapshot', async () => {
  const f = fixture()
  await f.started.promise
  const output = `\x1b[?2004h${'x'.repeat(3 * 1024 * 1024)}\r\nFINAL`
  f.emit(output)
  expect(f.onData).not.toHaveBeenCalled()
  f.receipt.resolve()
  await f.pending
  const [data, rawLength, transformed, seq] = f.onData.mock.calls[0]!
  expect(data.length).toBeLessThan(2 * 1024 * 1024)
  expect([rawLength, transformed, seq]).toEqual([output.length, true, output.length])
  const viewer = new HeadlessEmulator({ cols: 80, rows: 24 })
  try {
    await viewer.write(data)
    expect(viewer.getSnapshot().modes.bracketedPaste).toBe(true)
    expect(viewer.getSnapshot().snapshotAnsi).toContain('FINAL')
  } finally {
    viewer.dispose()
  }
  f.emit('NEXT')
  expect(f.onData.mock.calls.at(-1)?.[0]).toBe('NEXT')
  expect(f.host.takePendingOutput('startup', false)?.overflowed).toBe(true)
})

it('delivers final output before one exit when the shell exits before confirmation', async () => {
  const f = fixture()
  await f.started.promise
  f.emit('FINAL')
  f.exited.resolve(7)
  await Promise.resolve()
  expect(f.onExit).not.toHaveBeenCalled()
  f.receipt.resolve()
  await f.pending
  expect(f.onData.mock.calls[0]?.[0]).toBe('FINAL')
  expect(f.onExit).toHaveBeenCalledTimes(1)
  expect(f.onExit.mock.calls[0]?.[0]).toBe(7)
  expect(f.onData.mock.invocationCallOrder[0]).toBeLessThan(f.onExit.mock.invocationCallOrder[0]!)
})

it('cancels an unconfirmed attempt without publishing output or leaking ownership', async () => {
  const f = fixture()
  await f.started.promise
  f.emit('PRIVATE')
  const rejected = expect(f.pending).rejects.toThrow()
  f.controller.abort(new Error('canceled'))
  await rejected
  expect(f.onData).not.toHaveBeenCalled()
  expect(f.onExit).not.toHaveBeenCalled()
  expect(f.host.listSessions()).toEqual([])
  expect(f.terminal.closed).toBe(true)
})

it('cleans up after synchronous parser construction fails before receipt confirmation', async () => {
  vi.spyOn(HeadlessEmulator.prototype, 'writeSync').mockReturnValue(false)
  const f = fixture()
  await expect(f.pending).rejects.toThrow('requires synchronous parsing')
  expect(f.terminal.closed).toBe(true)
  expect(f.onData).not.toHaveBeenCalled()
  expect(f.onExit).not.toHaveBeenCalled()
  expect(f.host.listSessions()).toEqual([])
})

it('replays overflowed alternate screen, history seed, cursor and an incomplete escape before the live tail', async () => {
  const f = fixture(['SEEDED_HISTORY\r\n'])
  await f.started.promise
  f.emit(`\x1b[?1049h\x1b[?2004h${'x'.repeat(3 * 1024 * 1024)}\x1b[2;4HFINAL\x1b[3`)
  f.receipt.resolve()
  await f.pending
  const viewer = new HeadlessEmulator({ cols: 80, rows: 24 })
  try {
    await viewer.write(f.onData.mock.calls[0]![0])
    expect(viewer.getSnapshot().modes.alternateScreen).toBe(true)
    expect(viewer.getSnapshot().modes.bracketedPaste).toBe(true)
    f.emit('1mNEXT')
    await viewer.write(f.onData.mock.calls.at(-1)![0])
    expect(viewer.getSnapshot().snapshotAnsi).toContain('FINAL')
    expect(viewer.getSnapshot().snapshotAnsi).toContain('NEXT')
    expect(viewer.getSnapshot().snapshotAnsi).toContain('\x1b[31m')
    await viewer.write('\x1b[?1049l')
    expect(viewer.getSnapshot().snapshotAnsi).toContain('SEEDED_HISTORY')
  } finally {
    viewer.dispose()
  }
})
