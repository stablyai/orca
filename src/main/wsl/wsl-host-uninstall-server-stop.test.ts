import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslHostServerStop } from '../../shared/wsl-host-types'

const { execCommand, decommission, dispose } = vi.hoisted(() => ({
  execCommand: vi.fn<(conn: unknown, command: string) => Promise<string>>(),
  decommission: vi.fn(),
  dispose: vi.fn()
}))
vi.mock('../ssh/remote-exec/remote-exec-command', () => ({ execCommand }))
const { transportOptions } = vi.hoisted((): { transportOptions: unknown[] } => ({
  transportOptions: []
}))
vi.mock('./wsl-orcad-host-transport', () => ({
  createWslOrcadHostTransport: (options: unknown) => {
    transportOptions.push(options)
    return { dispose }
  }
}))
vi.mock('./wsl-host-server-stop', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  decommissionWslHostOrcad: () => decommission
}))

import {
  buildCensusCommand,
  buildCloseTerminalsCommand,
  stopWslHostServerFromGuest,
  stopWslHostServersForUninstall,
  type WslHostUninstallStopDependencies
} from './wsl-host-uninstall-server-stop'

function deps(
  overrides: Partial<WslHostUninstallStopDependencies> = {}
): WslHostUninstallStopDependencies {
  return {
    distros: () => ['Ubuntu', 'Debian'],
    listRunning: async () => ['ubuntu'],
    stop: vi.fn(async (): Promise<WslHostServerStop> => ({ stopped: true })),
    ...overrides
  }
}

describe('stopWslHostServersForUninstall', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('waits for an aborted stop to unwind before returning, so the holder outlives it', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const d = deps({
      timeoutMs: 1_000,
      stop: (_distro, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => {
              events.push('stop-unwound')
              resolve({ stopped: false, reason: 'aborted', verdict: 'unverifiable' })
            }, 500)
          })
        })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const done = stopWslHostServersForUninstall(d).then(() => events.push('returned'))
    await vi.advanceTimersByTimeAsync(1_500)
    await done

    expect(events).toEqual(['stop-unwound', 'returned'])
  })

  it('gives up on a distro that never answers, aborting its work', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const d = deps({
      timeoutMs: 1_000,
      stop: (_distro, s) => {
        signal = s
        return new Promise(() => {})
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const done = stopWslHostServersForUninstall(d)
    // The budget, then the bounded wait for the aborted stop to unwind.
    await vi.advanceTimersByTimeAsync(3_000)
    await done

    expect(signal?.aborted).toBe(true)
    expect(log).toHaveBeenCalledWith(
      '[wsl] uninstall could not stop the Ubuntu host server: timed out after 1000 ms'
    )
  })
})

describe('stopWslHostServerFromGuest', () => {
  afterEach(() => {
    execCommand.mockReset()
    decommission.mockReset()
    dispose.mockReset()
  })

  function terminals(count: number, worktrees: number) {
    return Array.from({ length: count }, (_, i) => ({
      handle: `term_${i}`,
      worktreeId: `repo::/home/u/w${i % worktrees}`
    }))
  }

  function guest(options: {
    live: ReturnType<typeof terminals>
    closeExit?: (i: number) => number
    census?: string
  }) {
    execCommand.mockImplementation(async (_conn, command) => {
      if (command.includes('UNINSTALL_CLOSE')) {
        const count = new Set(options.live.map((t) => t.worktreeId)).size
        return Array.from(
          { length: count },
          (_, i) => `UNINSTALL_CLOSE ${i} ${options.closeExit?.(i) ?? 0}`
        ).join('\n')
      }
      if (command.includes('UNINSTALL_CENSUS')) {
        return `banner\nUNINSTALL_CENSUS ${options.census ?? '0'}\n`
      }
      if (command.includes('terminal list')) {
        return `login banner\n${JSON.stringify({ result: { terminals: options.live } })}`
      }
      if (command.includes(' status ')) {
        return JSON.stringify({ result: { runtime: { runtimeId: 'rt-1' } } })
      }
      throw new Error(`unexpected ${command}`)
    })
  }

  it('stops 20 terminals in a fixed four wsl.exe calls, closing every worktree in parallel', async () => {
    guest({ live: terminals(20, 3) })
    decommission.mockResolvedValue({
      outcome: 'decommissioned',
      version: '1',
      retirement: 'retired'
    })

    const result = await stopWslHostServerFromGuest('Ubuntu', new AbortController().signal)

    expect(result).toEqual({ stopped: true })
    expect(execCommand).toHaveBeenCalledTimes(4)
    // The budget's signal also bounds decommission's own wsl.exe calls.
    expect(transportOptions.at(-1)).toMatchObject({ signal: expect.any(AbortSignal) })
    const close = execCommand.mock.calls
      .map(([, c]) => c)
      .find((c) => c.includes('UNINSTALL_CLOSE'))
    expect(close?.match(/terminal close --worktree 'id:repo::\/home\/u\/w\d' --all/g)).toHaveLength(
      3
    )
    expect(close).toMatch(/& wait$/)
    expect(decommission).toHaveBeenCalledWith(
      { liveSessions: 0, startedSinceActivation: null, daemonProtocolVersion: null },
      'rt-1'
    )
    expect(dispose).toHaveBeenCalled()
  })

  it('names the terminals of a worktree whose close failed and does not claim a stop', async () => {
    const live = terminals(4, 2)
    guest({ live, closeExit: (i) => (i === 1 ? 1 : 0), census: '2' })
    decommission.mockResolvedValue({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_decommission_terminals_running',
      reason: '2 terminals are still running'
    })

    const result = await stopWslHostServerFromGuest('Ubuntu', new AbortController().signal)

    expect(result).toMatchObject({ stopped: false, verdict: 'live' })
    expect(result.stopped === false && result.reason).toContain(
      'term_1 (repo::/home/u/w1): the close exited 1'
    )
    expect(result.stopped === false && result.reason).toContain('term_3 (repo::/home/u/w1)')
    // The in-guest census already waited; no host-side retries.
    expect(execCommand.mock.calls.filter(([, c]) => c.includes('UNINSTALL_CENSUS'))).toHaveLength(1)
  })

  it('counts a close that timed out (124) or never answered as a failure, not a success', async () => {
    const live = terminals(3, 3)
    execCommand.mockImplementation(async (_conn, command) => {
      if (command.includes('UNINSTALL_CLOSE')) {
        // Worktree 1 timed out; worktree 2 printed nothing.
        return 'UNINSTALL_CLOSE 0 0\nUNINSTALL_CLOSE 1 124\n'
      }
      if (command.includes('UNINSTALL_CENSUS')) {
        return 'UNINSTALL_CENSUS 2\n'
      }
      if (command.includes('terminal list')) {
        return JSON.stringify({ result: { terminals: live } })
      }
      return JSON.stringify({ result: { runtime: { runtimeId: 'rt-1' } } })
    })
    decommission.mockResolvedValue({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_decommission_terminals_running',
      reason: '2 terminals are still running'
    })

    const result = await stopWslHostServerFromGuest('Ubuntu', new AbortController().signal)

    expect(result).toMatchObject({ stopped: false, verdict: 'live' })
    const reason = result.stopped === false ? result.reason : ''
    expect(reason).toContain('term_1 (repo::/home/u/w1): the close exited 124')
    expect(reason).toContain('term_2 (repo::/home/u/w2): the close did not answer')
    expect(reason).not.toContain('term_0')
  })

  it('treats a census the CLI could not answer as unknown, never as zero', async () => {
    guest({ live: [], census: 'unknown' })
    decommission.mockResolvedValue({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_census_unavailable',
      reason: 'no session count'
    })

    const result = await stopWslHostServerFromGuest('Ubuntu', new AbortController().signal)

    expect(decommission).toHaveBeenCalledWith(
      expect.objectContaining({ liveSessions: null }),
      'rt-1'
    )
    expect(result).toMatchObject({ stopped: false, verdict: 'unverifiable' })
  })
})

describe('guest commands under a real POSIX shell', () => {
  const describeOnPosix = process.platform === 'win32' ? describe.skip : describe
  describeOnPosix('with a fake server CLI', () => {
    let home: string
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'orca-uninstall-guest-'))
      mkdirSync(join(home, '.orca', 'cli', 'bin'), { recursive: true })
    })
    afterEach(() => rmSync(home, { recursive: true, force: true }))

    function fakeCli(script: string): void {
      const path = join(home, '.orca', 'cli', 'bin', 'orca')
      writeFileSync(path, `#!/bin/sh\n${script}\n`)
      chmodSync(path, 0o755)
    }
    const sh = (command: string) =>
      spawnSync('/bin/sh', ['-c', command], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8'
      })

    it('closes each worktree and reports every exit code', () => {
      fakeCli('case "$4" in *w1) exit 3 ;; esac; echo "$@" >> "$HOME/closed"')

      const out = sh(buildCloseTerminalsCommand(['repo::/w0', 'repo::/w1', "repo::/it's"]))

      expect(out.stdout.split('\n').filter(Boolean).sort()).toEqual([
        'UNINSTALL_CLOSE 0 0',
        'UNINSTALL_CLOSE 1 3',
        'UNINSTALL_CLOSE 2 0'
      ])
      expect(readFileSync(join(home, 'closed'), 'utf8')).toContain("id:repo::/it's")
    })

    it('counts live terminals, and reports a failing list as unknown', () => {
      fakeCli('echo \'{"result":{"terminals":[{"handle":"a"},{"handle":"b"}]}}\'')
      expect(sh(buildCensusCommand(0)).stdout.trim()).toBe('UNINSTALL_CENSUS 2')

      fakeCli('echo \'{"result":{"terminals":[]}}\'')
      expect(sh(buildCensusCommand(0)).stdout.trim()).toBe('UNINSTALL_CENSUS 0')

      fakeCli('exit 1')
      expect(sh(buildCensusCommand(0)).stdout.trim()).toBe('UNINSTALL_CENSUS unknown')
    })
  })
})
