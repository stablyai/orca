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
vi.mock('./wsl-orcad-host-transport', () => ({
  createWslOrcadHostTransport: () => ({ dispose })
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
    await vi.advanceTimersByTimeAsync(1_000)
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
