import { describe, expect, it, vi } from 'vitest'
import {
  agentHookLaunchAuthorityRuntimeDeps,
  agentHookStatusStoreRuntimeDeps,
  wireRuntimeLaunchAuthorityReader
} from './agent-hook-runtime-deps'

// Every host builds its runtime's agent-hook deps here. Both options are optional, so a builder
// that dropped one would still typecheck: a command end would then fully retire a live agent's
// pane, and a verified exit would clear a session that started meanwhile.

type LaunchAuthorityReader = (paneKey: string) => { launchTokenHash: string | null } | null

function fakeServer() {
  const wired: { reader: LaunchAuthorityReader | null } = { reader: null }
  return {
    wired,
    getStatusSnapshot: vi.fn(() => []),
    getStatusSnapshotForPane: vi.fn(() => []),
    checkAgentPresence: vi.fn(async () => null),
    reconcileEndedProcessForPaneKeys: vi.fn(() => 0),
    attestCompatibilityAuthority: vi.fn(() => null),
    retirePaneAuthority: vi.fn(),
    setPaneLaunchAuthorityReader: vi.fn((reader: LaunchAuthorityReader | null) => {
      wired.reader = reader
    })
  }
}

describe('agent-hook runtime deps', () => {
  it('forward the command-end retirement options', () => {
    const server = fakeServer()

    agentHookLaunchAuthorityRuntimeDeps(server).retireAgentHookCompatibilityAuthority('pane', {
      authorityOnly: true
    })

    expect(server.retirePaneAuthority).toHaveBeenCalledWith('pane', undefined, {
      authorityOnly: true
    })
  })

  it('forward the ended-process options', () => {
    const server = fakeServer()
    const options = { preserveResumeIdentity: true, armedRowReceivedAt: 42 }

    agentHookStatusStoreRuntimeDeps(server).reconcileAgentStatusForEndedProcess(['pane'], options)

    expect(server.reconcileEndedProcessForPaneKeys).toHaveBeenCalledWith(['pane'], options)
  })

  it('hand the hook server the runtime as its launch-authority reader', () => {
    const server = fakeServer()
    const runtime = { readPaneLaunchAuthority: vi.fn(() => ({ launchTokenHash: 'hash' })) }

    wireRuntimeLaunchAuthorityReader(server, runtime)

    expect(server.wired.reader?.('pane')).toEqual({ launchTokenHash: 'hash' })
    expect(runtime.readPaneLaunchAuthority).toHaveBeenCalledWith('pane')
  })
})
