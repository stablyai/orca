// L4-m9: the local-desktop revoked-remote forget override proves "revoked" by
// absence from a READABLE pairing store. An unavailable registry (no reader
// wired, or a throwing one) proves nothing and must fail CLOSED — treating it
// as "no devices" would let the override clear a still-paired device's
// reservation.

import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getHostAgentLaunchBoundary } from '../agent-launch/agent-launch-boundary-host'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

type Internals = { resolveRevokedRemoteRowOwner: (scope: string) => string | null }

function makeRuntime(getPairedDeviceScopes?: () => readonly ('mobile' | 'runtime')[]): Internals {
  return new OrcaRuntimeService(
    null,
    undefined,
    getPairedDeviceScopes ? { getPairedDeviceScopes } : undefined
  ) as unknown as Internals
}

function stubMobileOwnedRow(scope: string): () => void {
  const spy = vi
    .spyOn(getHostAgentLaunchBoundary(), 'capacitySummaryFor')
    .mockImplementation((principal) =>
      principal.kind === 'remote' && principal.id === 'mobile'
        ? [
            {
              intent: 'interactive',
              scope,
              admittedAt: 1,
              launchToken: 'tok-1',
              baseHarness: 'claude',
              executionHostId: 'ssh:host-a'
            }
          ]
        : []
    )
  return () => spy.mockRestore()
}

describe('resolveRevokedRemoteRowOwner registry availability gate', () => {
  it('fails closed when no device-registry reader is wired', () => {
    const restore = stubMobileOwnedRow('wt-1')
    const runtime = makeRuntime(undefined)
    expect(runtime.resolveRevokedRemoteRowOwner('wt-1')).toBeNull()
    restore()
  })

  it('fails closed when the device-registry reader throws', () => {
    const restore = stubMobileOwnedRow('wt-1')
    const runtime = makeRuntime(() => {
      throw new Error('registry store unreadable')
    })
    expect(runtime.resolveRevokedRemoteRowOwner('wt-1')).toBeNull()
    restore()
  })

  it('still resolves a genuinely revoked owner from a readable empty registry', () => {
    const restore = stubMobileOwnedRow('wt-1')
    // Readable registry with zero paired devices: mobile IS revoked and owns
    // the remote-host row, so the override applies.
    const runtime = makeRuntime(() => [])
    expect(runtime.resolveRevokedRemoteRowOwner('wt-1')).toBe('mobile')
    restore()
  })

  it('skips a still-paired kind even when it owns the row', () => {
    const restore = stubMobileOwnedRow('wt-1')
    const runtime = makeRuntime(() => ['mobile'])
    expect(runtime.resolveRevokedRemoteRowOwner('wt-1')).toBeNull()
    restore()
  })
})
