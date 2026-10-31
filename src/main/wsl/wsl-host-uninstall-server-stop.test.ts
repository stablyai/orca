import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it("closes every terminal through the server's CLI, then decommissions the proven instance", async () => {
    const open = new Set(['term_a', 'term_b'])
    execCommand.mockImplementation(async (_conn, command) => {
      if (command.includes('terminal list')) {
        const terminals = [...open].map((handle) => ({ handle, worktreeId: 'w' }))
        return `login banner\n${JSON.stringify({ result: { terminals } })}`
      }
      if (command.includes('terminal close')) {
        open.delete(/--terminal '([^']+)'/.exec(command)?.[1] ?? '')
        return JSON.stringify({ result: {} })
      }
      if (command.includes(' status ')) {
        return JSON.stringify({ result: { runtime: { runtimeId: 'rt-1' } } })
      }
      throw new Error(`unexpected ${command}`)
    })
    decommission.mockResolvedValue({
      outcome: 'decommissioned',
      version: '1',
      retirement: 'retired'
    })

    const result = await stopWslHostServerFromGuest('Ubuntu', new AbortController().signal)

    expect(result).toEqual({ stopped: true })
    expect(open.size).toBe(0)
    expect(decommission).toHaveBeenCalledWith(
      { liveSessions: 0, startedSinceActivation: null, daemonProtocolVersion: null },
      'rt-1'
    )
    expect(
      execCommand.mock.calls.every(([, c]) => c.startsWith('"$HOME/.orca/cli/bin/orca" '))
    ).toBe(true)
    // Remove host lists up to 1000; the CLI's default of 200 would leave terminals open.
    const lists = execCommand.mock.calls
      .map(([, c]) => c)
      .filter((c) => c.includes('terminal list'))
    expect(lists.length).toBeGreaterThan(0)
    expect(lists.every((c) => c.includes('terminal list --limit 1000 --json'))).toBe(true)
    expect(dispose).toHaveBeenCalled()
  })

  it('reports the server it could not prove stopped', async () => {
    execCommand.mockImplementation(async (_conn, command) =>
      command.includes('status')
        ? JSON.stringify({ result: { runtime: { runtimeId: 'rt-1' } } })
        : JSON.stringify({ result: { terminals: [] } })
    )
    decommission.mockResolvedValue({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'x',
      reason: 'not the active instance'
    })

    const result = await stopWslHostServerFromGuest('Ubuntu', new AbortController().signal)

    expect(result).toMatchObject({ stopped: false, verdict: 'unverifiable' })
    expect(dispose).toHaveBeenCalled()
  })
})
