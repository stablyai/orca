import { describe, expect, it, vi } from 'vitest'
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import {
  stopWslHostServer,
  wslHostRuntimeStopSteps,
  type WslHostRuntimeAccess,
  type WslHostServerStopSteps
} from './wsl-host-server-stop'
import type { WslHostPeerDesktops } from './wsl-host-peer-desktops'

function census(liveSessions: number | null): OrcadTerminalCensus {
  return { liveSessions, startedSinceActivation: liveSessions, daemonProtocolVersion: 1 }
}

const RETIRED: OrcadDecommissionResult = {
  outcome: 'decommissioned',
  version: '1.0.0',
  retirement: 'retired'
}

function steps(overrides: Partial<WslHostServerStopSteps> = {}) {
  const order: string[] = []
  const all: WslHostServerStopSteps = {
    peerDesktops: vi.fn(async (): Promise<WslHostPeerDesktops> => ({ kind: 'none' })),
    endTerminals: vi.fn(async () => {
      order.push('endTerminals')
      return []
    }),
    census: vi.fn(async () => {
      order.push('census')
      return census(0)
    }),
    servingRuntimeId: vi.fn(async () => {
      order.push('servingRuntimeId')
      return 'runtime-a'
    }),
    closeBridge: vi.fn(async () => {
      order.push('closeBridge')
    }),
    decommission: vi.fn(async () => {
      order.push('decommission')
      return RETIRED
    }),
    sleep: vi.fn(async () => {}),
    ...overrides
  }
  return { all, order }
}

describe('stopWslHostServer', () => {
  it('closes terminals, proves none remain, names the serving orcad, then retires it', async () => {
    const { all, order } = steps()
    await expect(stopWslHostServer(all)).resolves.toEqual({ stopped: true })
    expect(order).toEqual([
      'endTerminals',
      'census',
      'servingRuntimeId',
      'closeBridge',
      'decommission'
    ])
    expect(all.decommission).toHaveBeenCalledWith(census(0), 'runtime-a')
  })

  it('keeps a server another Orca shares: only this desktop lets go, nothing ends', async () => {
    const { all, order } = steps({
      peerDesktops: vi.fn(async (): Promise<WslHostPeerDesktops> => ({
        kind: 'shared',
        names: ['Orca Dev']
      }))
    })
    await expect(stopWslHostServer(all)).resolves.toEqual({
      stopped: true,
      keptForOtherDesktops: ['Orca Dev']
    })
    expect(order).toEqual(['closeBridge'])
  })

  it('refuses the teardown when the server cannot say who else uses it', async () => {
    const { all, order } = steps({
      peerDesktops: vi.fn(async () => {
        throw new Error('runtime_device_required')
      })
    })
    await expect(stopWslHostServer(all)).resolves.toMatchObject({
      stopped: false,
      verdict: 'unverifiable',
      reason: expect.stringContaining('another Orca on this computer')
    })
    expect(order).toEqual(['closeBridge'])
  })

  it("keeps today's teardown, with a warning, for a server that predates the check", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { all, order } = steps({
      peerDesktops: vi.fn(async (): Promise<WslHostPeerDesktops> => ({ kind: 'unsupported' }))
    })
    await expect(stopWslHostServer(all)).resolves.toEqual({ stopped: true })
    expect(order).toContain('decommission')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('predates the shared-host check'))
    warn.mockRestore()
  })

  it('reports a daemon that did not retire', async () => {
    const { all } = steps({
      decommission: vi.fn(async (): Promise<OrcadDecommissionResult> => ({
        ...RETIRED,
        retirement: 'live'
      }))
    })
    await expect(stopWslHostServer(all)).resolves.toEqual({
      stopped: false,
      reason: 'Orca’s server stopped, but its terminal daemon is still running.',
      verdict: 'live'
    })
  })
})

describe('wslHostRuntimeStopSteps', () => {
  it('closes every terminal by handle and keeps going past one that fails', async () => {
    const call = vi.fn(async (_environmentId: string, method: string, params: unknown) => {
      if (method === 'terminal.list') {
        return {
          terminals: [
            { handle: 'term_orphan', worktreeId: 'gone::/home/me/old' },
            { handle: 'term_live', worktreeId: 'app::/home/me/app' }
          ]
        }
      }
      if (method === 'terminal.close' && JSON.stringify(params).includes('term_orphan')) {
        throw new Error('selector_not_found')
      }
      return {}
    })
    const access: WslHostRuntimeAccess = { call, census: async () => census(0) }

    await expect(wslHostRuntimeStopSteps(access, 'wsl:ubuntu').endTerminals()).resolves.toEqual([
      { handle: 'term_orphan', worktreeId: 'gone::/home/me/old', reason: 'selector_not_found' }
    ])
    expect(call).toHaveBeenCalledWith('wsl:ubuntu', 'terminal.close', { terminal: 'term_live' })
    expect(call).not.toHaveBeenCalledWith('wsl:ubuntu', 'terminal.stop', expect.anything())
  })
})
