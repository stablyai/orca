import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const nodePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => nodePty)
const ptyJob = vi.hoisted(() => ({
  assignHostProcessToKillOnCloseJob: vi.fn(),
  terminatePtyJob: vi.fn(),
  killConptyNow: vi.fn()
}))
vi.mock('../../windows/windows-pty-job', () => ptyJob)

import '../mock-descendant-sweep'
import { TerminalHost } from '../terminal-host'
import { TerminalSpawnGate } from '../terminal-spawn-gate'
import { TerminalCreationWork } from '../terminal-creation-work'
import { IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS } from '../immediate-kill-reply-budget'
import { createDaemonPtySubprocessHandle } from './subprocess-handle'
import { spawnNativeDaemonPty } from './native-pty-spawn'
import { Session } from '../session'
import { readTerminalStartFailure } from '../../../shared/terminal-start-failure'
import { mapRuntimeError } from '../../runtime/rpc/errors'
import {
  _resetConptyStartupTrustForTest,
  CONPTY_NO_INPUT_READER_NOTICE,
  CONPTY_STARTUP_DECISION_LIMIT_MS
} from './conpty-startup-input-reader'

const attempts = ['pwsh.exe', 'powershell.exe', 'cmd.exe'].map((shellPath) => ({
  shellPath,
  shellArgs: [shellPath === 'cmd.exe' ? '/K' : '-NoExit'],
  effectiveCwd: 'C:\\work',
  validationCwd: 'C:\\work',
  startupCommandDeliveredInShellArgs: true
}))
const args = {
  primaryArgsRespawnSafe: true,
  shellPath: attempts[0]!.shellPath,
  shellArgs: attempts[0]!.shellArgs,
  spawnCwd: 'C:\\work',
  env: {},
  cols: 80,
  rows: 24,
  windowsFallbackAttempts: attempts
}

const CONPTY_PRELUDE = '\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h'
const CAPACITY_MARKER = 'too many consoles in use, max consoles is 128'

/** A pane that writes `chunks` on later ticks, as ConPTY's output socket does. */
function fakePane(pid: number, chunks: string[], exitCode?: number) {
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number }) => void>()
  const pane = {
    pid,
    kill: vi.fn(() => {
      for (const listener of exitListeners) {
        listener({ exitCode: 137 })
      }
    }),
    destroy: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    emitData: (data: string) => {
      for (const listener of dataListeners) {
        listener(data)
      }
    },
    emitExit: (exitCode: number) => {
      for (const listener of exitListeners) {
        listener({ exitCode })
      }
    },
    onData: (listener: (data: string) => void) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListeners.add(listener)
      return { dispose: () => exitListeners.delete(listener) }
    }
  }
  void (async () => {
    for (const chunk of chunks) {
      await new Promise((resolve) => setImmediate(resolve))
      for (const listener of dataListeners) {
        listener(chunk)
      }
    }
    if (exitCode !== undefined) {
      await new Promise((resolve) => setImmediate(resolve))
      for (const listener of exitListeners) {
        listener({ exitCode })
      }
    }
  })()
  return pane
}

const healthyPane = (pid: number) => fakePane(pid, [CONPTY_PRELUDE])
const deadPane = (pid: number) => fakePane(pid, ['Microsoft Windows\r\n'])

describe('Windows shell fallback over node-pty ConPTY', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    nodePty.spawn.mockReset()
    ptyJob.terminatePtyJob.mockReset().mockReturnValue('unavailable')
    ptyJob.killConptyNow.mockReset().mockReturnValue(false)
    _resetConptyStartupTrustForTest()
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('classifies installed-DLL-format-derived bytes through fresh rejection and the RPC envelope', async () => {
    // Expanded installed DLL format strings with max 128/PID 4242; not a console-exhaustion capture.
    const bytes = readFileSync(
      new URL('../__fixtures__/git-bash-installed-dll-format-capacity.bin', import.meta.url)
    )
    expect(bytes.length).toBe(166)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '7a0b4edc10fbd6c3cc4186031ed67d640db5a357b934daafa12c99663b59e17b'
    )
    let proc: ReturnType<typeof fakePane> | undefined
    nodePty.spawn.mockImplementationOnce(() => {
      proc = fakePane(4242, [bytes.toString('utf8')], 256)
      return proc
    })
    const host = new TerminalHost({
      spawnSubprocess: async (options) => {
        const spawned = await spawnNativeDaemonPty({
          ...args,
          shellPath: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
          shellArgs: [],
          primaryArgsRespawnSafe: false
        })
        await spawned.physicalOwner?.completion
        expect(spawned.physicalOwner?.exitCode()).toBe(256)
        return createDaemonPtySubprocessHandle({
          ...spawned,
          env: {},
          sessionId: options.sessionId,
          startupCommandDeliveredInShellArgs: false,
          startupAgentRecognition: null,
          startupEvents: spawned.claimStartupEvents?.()
        })
      }
    })
    try {
      const error: unknown = await host
        .createOrAttach({
          sessionId: 'dll-format-capacity',
          cols: 80,
          rows: 24,
          streamClient: { onData() {}, onExit() {} }
        })
        .then(
          () => null,
          (rejection: unknown) => rejection
        )
      expect(error).toBeInstanceOf(Error)
      expect(readTerminalStartFailure(error)).toEqual({
        incarnationId: expect.any(String),
        cause: {
          kind: 'exited',
          exitCode: 256,
          initialOutputDiagnostic: 'git-bash-console-capacity'
        }
      })
      expect(mapRuntimeError('dll-format', { runtimeId: 'runtime' }, error)).toEqual({
        id: 'dll-format',
        ok: false,
        _meta: { runtimeId: 'runtime' },
        error: {
          code: 'agent_session_exited_during_start',
          message: expect.stringContaining('Close some Git Bash terminals')
        }
      })
      expect(host.listSessions()).toEqual([])
      expect(nodePty.spawn).toHaveBeenCalledOnce()
      expect(proc?.kill).not.toHaveBeenCalled()
    } finally {
      await host.dispose()
    }
  })

  it.each([
    {
      name: 'marker survives pre-listener eviction',
      startup: `\x1b[c${CAPACITY_MARKER}`,
      pending: ['x'.repeat(512 * 1024)],
      detected: true
    },
    {
      name: 'eviction cannot move a late marker into the prefix',
      startup: `\x1b[c${'x'.repeat(512 * 1024)}`,
      pending: [CAPACITY_MARKER],
      detected: false
    },
    {
      name: 'DA1 removal cannot move a marker ending at raw offset 4099 into the prefix',
      startup: `\x1b[c${'x'.repeat(4096 - CAPACITY_MARKER.length)}${CAPACITY_MARKER}`,
      pending: [],
      detected: false
    },
    {
      name: 'marker ending at original offset 4096 qualifies',
      startup: `\x1b[c${'x'.repeat(4096 - 3 - CAPACITY_MARKER.length)}${CAPACITY_MARKER}`,
      pending: [],
      detected: true
    },
    {
      name: 'marker spans the ConPTY handover',
      startup: `\x1b[c${CAPACITY_MARKER.slice(0, 20)}`,
      pending: [CAPACITY_MARKER.slice(20)],
      detected: true
    },
    {
      name: 'WSL output remains unclassified',
      shellPath: 'C:\\Windows\\System32\\wsl.exe',
      startup: `\x1b[c${CAPACITY_MARKER}`,
      pending: [],
      detected: false
    }
  ])(
    'classifies the original native prefix: $name',
    async ({ startup, pending, detected, shellPath }) => {
      const proc = fakePane(990020, [startup])
      nodePty.spawn.mockReturnValueOnce(proc)
      const spawned = await spawnNativeDaemonPty({
        ...args,
        ...(shellPath ? { shellPath, shellArgs: [] } : {})
      })
      const handle = createDaemonPtySubprocessHandle({
        ...spawned,
        env: {},
        sessionId: 'raw-prefix',
        startupCommandDeliveredInShellArgs: false,
        startupAgentRecognition: null,
        startupEvents: spawned.claimStartupEvents?.()
      })
      for (const chunk of pending) {
        proc.emitData(chunk)
      }
      proc.emitExit(256)
      const delivered: string[] = []
      const onData = handle.onData
      handle.onData = (callback) =>
        onData((data) => {
          delivered.push(data)
          callback(data)
        })
      const exit = vi.fn()
      const session = new Session({
        sessionId: 'raw-prefix',
        subprocess: handle,
        cols: 80,
        rows: 24,
        ownerBackend: shellPath ? 'windows-wsl' : 'windows-conpty',
        shellReadySupported: false,
        onExit: exit
      })
      expect(exit).toHaveBeenCalledExactlyOnceWith(256)
      expect(session.exitCause).toEqual({
        kind: 'exited',
        exitCode: 256,
        ...(detected ? { initialOutputDiagnostic: 'git-bash-console-capacity' } : {})
      })
      expect(delivered.join('')).toBe(
        startup.length + pending.join('').length - 3 > 512 * 1024
          ? pending.join('')
          : startup.slice(3) + pending.join('')
      )
      expect(proc.write).toHaveBeenCalledExactlyOnceWith('\x1b[?61;4c')
      expect(nodePty.spawn).toHaveBeenCalledOnce()
      session.dispose()
      expect(proc.kill).not.toHaveBeenCalled()
    }
  )

  it('keeps operator-close precedence over the raw owner diagnostic', async () => {
    const proc = fakePane(990021, [`\x1b[c${CAPACITY_MARKER}`])
    nodePty.spawn.mockReturnValueOnce(proc)
    const spawned = await spawnNativeDaemonPty(args)
    const handle = createDaemonPtySubprocessHandle({
      ...spawned,
      env: {},
      sessionId: 'operator-close',
      startupCommandDeliveredInShellArgs: false,
      startupAgentRecognition: null,
      startupEvents: spawned.claimStartupEvents?.()
    })
    const report = vi.fn()
    const session = new Session({
      sessionId: 'operator-close',
      subprocess: handle,
      cols: 80,
      rows: 24,
      ownerBackend: 'windows-conpty',
      shellReadySupported: false,
      reportReadinessEvent: report
    })
    expect(session.beginTermination()).toBe(true)
    proc.emitExit(256)
    expect(session.exitCause).toEqual({ kind: 'operator_close' })
    expect(
      report.mock.calls.filter(([event]) => event === 'session-initial-output-diagnostic')
    ).toEqual([])
    session.dispose()
  })

  it('keeps a WSL pane out of a distro the internal allowlist excludes, falling back past it', async () => {
    vi.stubEnv('ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST', 'orca-test-a')
    try {
      const wslAttempts = ['Ubuntu', 'orca-test-a'].map((distro) => ({
        ...attempts[0]!,
        shellPath: 'C:\\Windows\\System32\\wsl.exe',
        shellArgs: ['-d', distro, '--cd', '~']
      }))
      nodePty.spawn.mockReturnValue(healthyPane(4242))
      const result = await spawnNativeDaemonPty({
        ...args,
        shellPath: wslAttempts[0]!.shellPath,
        shellArgs: wslAttempts[0]!.shellArgs,
        windowsFallbackAttempts: wslAttempts
      })
      expect(nodePty.spawn.mock.calls.map(([, argv]) => argv)).toEqual([
        ['-d', 'orca-test-a', '--cd', '~']
      ])
      expect(result.shellPath).toBe(wslAttempts[1]!.shellPath)

      nodePty.spawn.mockClear()
      await expect(
        spawnNativeDaemonPty({
          ...args,
          shellPath: wslAttempts[0]!.shellPath,
          shellArgs: wslAttempts[0]!.shellArgs,
          windowsFallbackAttempts: [wslAttempts[0]!]
        })
      ).rejects.toMatchObject({ code: 'ORCA_WSL_DISTRO_NOT_ALLOWLISTED' })
      expect(nodePty.spawn).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('walks both fallback shells when ConPTY rejects the primary ones', async () => {
    const proc = fakePane(9876, [CONPTY_PRELUDE])
    nodePty.spawn.mockImplementation((file: string) => {
      if (file !== 'cmd.exe') {
        throw new Error(`spawn ${file} EACCES`)
      }
      return proc
    })
    const result = await spawnNativeDaemonPty(args)
    expect(nodePty.spawn.mock.calls.map(([file]) => file)).toEqual([
      'pwsh.exe',
      'powershell.exe',
      'cmd.exe'
    ])
    expect(nodePty.spawn.mock.calls[2]![2]).toMatchObject({ useConptyDll: true })
    expect(result.process).toBe(proc)
    expect(result.shellPath).toBe('cmd.exe')
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('respawns a pane whose ConPTY never started reading input', async () => {
    // Measured on CI: such a pane prints its banner and prompt, then ignores every keystroke.
    const broken = fakePane(990001, ['Microsoft Windows [Version 10.0.20348]\r\n'])
    const healthy = fakePane(990002, ['\x1b[1t', '\x1b[c\x1b[?1004h', 'Microsoft Windows'])
    nodePty.spawn.mockReturnValueOnce(broken).mockReturnValueOnce(healthy)

    const result = await spawnNativeDaemonPty(args)

    expect(nodePty.spawn.mock.calls.map(([file]) => file)).toEqual(['pwsh.exe', 'pwsh.exe'])
    expect(ptyJob.terminatePtyJob).toHaveBeenCalledWith(broken)
    expect(broken.kill).toHaveBeenCalledOnce()
    expect(broken.write).not.toHaveBeenCalled()
    expect(result.process).toBe(healthy)
    expect(result.shellPath).toBe('pwsh.exe')
    expect(healthy.write).toHaveBeenCalledExactlyOnceWith('\x1b[?61;4c')
    expect(result.claimStartupEvents?.().data).toEqual(['\x1b[1t\x1b[?1004h'])
  })

  it.each(['physical-exit', 'deadline', 'observation-retry'] as const)(
    'ordinary create keeps the startup predecessor owned through %s and host disposal',
    async (outcome) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const broken = deadPane(990010)
      broken.kill.mockImplementation(() => {})
      if (outcome === 'observation-retry') {
        vi.spyOn(broken, 'onExit').mockImplementationOnce(() => {
          throw new Error('initial exit subscription failed')
        })
        // The native close request returns but cannot establish exit; the job is unavailable.
        ptyJob.killConptyNow.mockReturnValue(true)
      }
      const replacement = fakePane(990011, [])
      nodePty.spawn.mockReturnValueOnce(broken).mockReturnValueOnce(replacement)
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('Windows cleanup must not signal an unchecked PID')
      })
      ptyJob.terminatePtyJob.mockImplementation((proc) => {
        if (proc === replacement) {
          queueMicrotask(() => replacement.emitExit(137))
        }
        return outcome === 'observation-retry' ? 'unavailable' : 'terminated'
      })
      const gate = new TerminalSpawnGate({ log: () => {} })
      const host = new TerminalHost({
        spawnGate: gate,
        spawnSubprocess: async (options) => {
          const work = new TerminalCreationWork()
          try {
            const spawned = await spawnNativeDaemonPty({ ...args, creationWork: work })
            return createDaemonPtySubprocessHandle({
              ...spawned,
              env: {},
              sessionId: options.sessionId,
              startupCommandDeliveredInShellArgs: false,
              startupAgentRecognition: null,
              startupEvents: spawned.claimStartupEvents?.()
            })
          } finally {
            await work.finish()
            options.onCreationDisposition?.(await work.completion)
          }
        }
      })
      const creating = host.createOrAttach({
        sessionId: 'ordinary-conpty',
        cols: 80,
        rows: 24,
        streamClient: { onData() {}, onExit() {} }
      })
      const creationSettled = creating.then(
        () => null,
        (error: unknown) => error
      )
      try {
        if (outcome === 'observation-retry') {
          await vi.waitFor(() => expect(ptyJob.killConptyNow).toHaveBeenCalledOnce())
          await vi.advanceTimersByTimeAsync(IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS)
          expect(await creationSettled).toBeInstanceOf(Error)
          expect(host.listSessions()).toEqual([])
          expect(gate.snapshot().terminals).toBe(1)
          // Let the automatic failed-create recovery also exhaust its bounded exit wait.
          await vi.advanceTimersByTimeAsync(IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS)
          const requests = ptyJob.terminatePtyJob.mock.calls.length
          ptyJob.terminatePtyJob.mockImplementation(() => {
            queueMicrotask(() => broken.emitExit(137))
            return 'terminated'
          })
          await host.dispose()
          expect(ptyJob.terminatePtyJob.mock.calls.length).toBeGreaterThan(requests)
          expect(ptyJob.killConptyNow).toHaveBeenCalledOnce()
          expect(broken.kill).not.toHaveBeenCalled()
          expect(broken.destroy).not.toHaveBeenCalled()
          expect(process.kill).not.toHaveBeenCalled()
          expect(nodePty.spawn).toHaveBeenCalledOnce()
          expect(gate.snapshot().terminals).toBe(0)
          expect(host.listSessions()).toEqual([])
          return
        }
        await vi.waitFor(() => expect(broken.kill).toHaveBeenCalledOnce())
        expect(nodePty.spawn).toHaveBeenCalledOnce()
        expect(host.listSessions()).toEqual([])
        if (outcome === 'physical-exit') {
          broken.emitExit(137)
          await vi.waitFor(() => expect(nodePty.spawn).toHaveBeenCalledTimes(2))
          replacement.emitData(CONPTY_PRELUDE)
        } else {
          await vi.advanceTimersByTimeAsync(CONPTY_STARTUP_DECISION_LIMIT_MS)
        }
        const created = await creating
        expect(created.isNew).toBe(true)
        expect(created.pid).toBe(outcome === 'physical-exit' ? replacement.pid : broken.pid)
        expect(nodePty.spawn).toHaveBeenCalledTimes(outcome === 'physical-exit' ? 2 : 1)
        expect(gate.snapshot().terminals).toBe(1)
        if (outcome === 'deadline') {
          ptyJob.terminatePtyJob.mockReturnValue('unavailable')
          const disposing = host.dispose().then(
            () => null,
            (error: unknown) => error
          )
          await vi.waitFor(() =>
            expect(
              ptyJob.terminatePtyJob.mock.calls.filter(([proc]) => proc === broken).length
            ).toBeGreaterThan(1)
          )
          expect(gate.snapshot().terminals).toBe(1)
          expect(host.listSessions()).toHaveLength(1)
          await vi.advanceTimersByTimeAsync(IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS)
          expect(await disposing).toBeInstanceOf(Error)
          expect(gate.snapshot().terminals).toBe(1)
          expect(host.listSessions()).toHaveLength(1)
          // The same owner's force request must reach the now-available job after the timeout.
          const requests = ptyJob.terminatePtyJob.mock.calls.length
          ptyJob.terminatePtyJob.mockImplementation(() => {
            queueMicrotask(() => broken.emitExit(137))
            return 'terminated'
          })
          const retrying = host.dispose()
          await vi.waitFor(() =>
            expect(ptyJob.terminatePtyJob.mock.calls.length).toBeGreaterThan(requests)
          )
          await retrying
          expect(broken.kill).toHaveBeenCalledOnce()
          expect(broken.destroy).not.toHaveBeenCalled()
        } else {
          await host.dispose()
        }
        expect(gate.snapshot().terminals).toBe(0)
        expect(host.listSessions()).toEqual([])
        expect(process.kill).not.toHaveBeenCalled()
      } finally {
        broken.emitExit(137)
        replacement.emitExit(137)
        await host.dispose()
      }
    }
  )

  it('respawns only once, then says so in the pane', async () => {
    nodePty.spawn.mockReturnValueOnce(healthyPane(990001))
    await spawnNativeDaemonPty(args)
    const first = deadPane(990002)
    const second = deadPane(990003)
    nodePty.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)

    const result = await spawnNativeDaemonPty(args)

    expect(nodePty.spawn).toHaveBeenCalledTimes(3)
    expect(second.kill).not.toHaveBeenCalled()
    expect(result.process).toBe(second)
    expect(result.claimStartupEvents?.().data).toEqual([
      'Microsoft Windows\r\n',
      CONPTY_NO_INPUT_READER_NOTICE
    ])
  })

  it('never respawns a shell whose argv may carry a command', async () => {
    nodePty.spawn.mockReturnValueOnce(healthyPane(990001))
    await spawnNativeDaemonPty(args)
    const dead = deadPane(990002)
    nodePty.spawn.mockReturnValueOnce(dead)

    const result = await spawnNativeDaemonPty({ ...args, primaryArgsRespawnSafe: false })

    expect(nodePty.spawn).toHaveBeenCalledTimes(2)
    expect(dead.kill).not.toHaveBeenCalled()
    expect(result.claimStartupEvents?.().data.at(-1)).toBe(CONPTY_NO_INPUT_READER_NOTICE)
  })

  it('stops checking when no pane ever announces, as a changed ConPTY build would', async () => {
    nodePty.spawn.mockReturnValueOnce(deadPane(990001)).mockReturnValueOnce(deadPane(990002))
    const result = await spawnNativeDaemonPty(args)
    expect(result.claimStartupEvents?.().data).not.toContain(CONPTY_NO_INPUT_READER_NOTICE)

    const later = deadPane(990003)
    nodePty.spawn.mockReturnValueOnce(later)
    expect((await spawnNativeDaemonPty(args)).process).toBe(later)
    expect(nodePty.spawn).toHaveBeenCalledTimes(3)
  })

  it('hands out a WinPTY pane unchecked, since only ConPTY announces an input reader', async () => {
    // Windows builds below 18309 get WinPTY, whose native kill throws when repeated (#36317).
    const winpty = Object.assign(deadPane(990001), { _agent: { _useConpty: false } })
    nodePty.spawn.mockReturnValueOnce(winpty)

    const result = await spawnNativeDaemonPty(args)

    expect(nodePty.spawn).toHaveBeenCalledOnce()
    expect(winpty.kill).not.toHaveBeenCalled()
    expect(ptyJob.killConptyNow).not.toHaveBeenCalled()
    expect(result.process).toBe(winpty)
  })

  it('does not respawn a shell that exited before ConPTY announced anything', async () => {
    const exited = fakePane(990001, [], 3)
    nodePty.spawn.mockReturnValueOnce(exited)

    const result = await spawnNativeDaemonPty(args)

    expect(nodePty.spawn).toHaveBeenCalledOnce()
    expect(result.claimStartupEvents?.().exit).toEqual({ exitCode: 3 })
  })

  it('kills the pane tree when the spawn is canceled while startup is awaited', async () => {
    const controller = new AbortController()
    const silent = fakePane(990001, [])
    silent.kill.mockImplementation(() => {})
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('unchecked Windows PID')
    })
    nodePty.spawn.mockReturnValueOnce(silent)
    const spawned = spawnNativeDaemonPty({ ...args, signal: controller.signal })
    await new Promise((resolve) => setImmediate(resolve))
    let settled = false
    const rejected = expect(spawned)
      .rejects.toThrow('spawn canceled')
      .then(() => {
        settled = true
      })
    controller.abort(new Error('spawn canceled'))
    await vi.waitFor(() => expect(silent.kill).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(nodePty.spawn).toHaveBeenCalledOnce()
    silent.emitExit(137)
    await rejected
    expect(process.kill).not.toHaveBeenCalled()
    expect(ptyJob.terminatePtyJob).toHaveBeenCalledWith(silent)
    // node-pty defers kill() until first output, which a silent pane never produces.
    expect(ptyJob.killConptyNow).toHaveBeenCalledWith(silent)
    expect(silent.kill).toHaveBeenCalledOnce()
    expect(nodePty.spawn).toHaveBeenCalledOnce()
  })

  it('hands out a pane that stays silent instead of stalling the spawn', async () => {
    vi.useFakeTimers()
    const silent = fakePane(990001, [])
    nodePty.spawn.mockReturnValueOnce(silent)
    const spawned = spawnNativeDaemonPty(args)
    await vi.advanceTimersByTimeAsync(CONPTY_STARTUP_DECISION_LIMIT_MS)
    const result = await spawned
    vi.useRealTimers()

    expect(nodePty.spawn).toHaveBeenCalledOnce()
    expect(silent.kill).not.toHaveBeenCalled()
    expect(result.process).toBe(silent)
  })

  it('starts no fallback shell once the spawn is canceled', async () => {
    const controller = new AbortController()
    nodePty.spawn.mockImplementation(() => {
      controller.abort(new Error('spawn canceled'))
      throw new Error('spawn pwsh.exe EACCES')
    })
    await expect(spawnNativeDaemonPty({ ...args, signal: controller.signal })).rejects.toThrow(
      'spawn canceled'
    )
    expect(nodePty.spawn).toHaveBeenCalledOnce()
  })
})
