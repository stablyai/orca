import { afterEach, expect, it, vi } from 'vitest'
import * as ownership from '../../shared/workspace-session/desktop-relay-ownership'
import { DESKTOP_RELAY_WRITE_VERSION } from '../../shared/workspace-session/desktop-relay-write'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
import { registerDesktopRelayHandlers } from './session-desktop-relays'

// Perf contract: every terminal save sends each SSH host's relay ids; main applies ownership only to
// the hosts whose ids or partition changed, so one relay change costs one host, not the fleet.

afterEach(() => {
  handlers.clear()
  vi.restoreAllMocks()
})

function hostWrites(hosts: number, changedHost: number) {
  return Array.from({ length: hosts }, (_, host) => ({
    hostId: `ssh:box-${host}`,
    complete: true,
    relayIdsByTabId: Object.fromEntries(
      Array.from({ length: 50 }, (_, tab) => [
        `tab-${host}-${tab}`,
        `ssh:box-${host}@@relay-${tab}${host === changedHost ? '-new' : ''}`
      ])
    )
  }))
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay apply reads only the relay fields.
const EMPTY = {} as WorkspaceSessionState

function ownershipAppliesForOneRelayChange(hosts: number): number {
  const partitions = new Map<string, WorkspaceSessionState>()
  const store = {
    getRepos: () => [],
    getWorkspaceSessionHostIds: () => [],
    getWorkspaceSession: (hostId?: string | null) => partitions.get(hostId ?? '') ?? EMPTY,
    patchWorkspaceSession: (patch: Partial<WorkspaceSessionState>, hostId?: string | null) => {
      const key = hostId ?? ''
      partitions.set(key, { ...(partitions.get(key) ?? EMPTY), ...patch })
    }
  }
  registerDesktopRelayHandlers(
    store,
    () => false,
    () => {}
  )
  const apply = handlers.get('session:apply-desktop-relays')!
  apply(null, { version: DESKTOP_RELAY_WRITE_VERSION, hosts: hostWrites(hosts, -1) })
  const applies = vi.spyOn(ownership, 'applyDesktopRelayWrite')

  apply(null, { version: DESKTOP_RELAY_WRITE_VERSION, hosts: hostWrites(hosts, 7) })

  const count = applies.mock.calls.length
  applies.mockRestore()
  return count
}

it('one relay change applies ownership to one host, at 20 and 200 SSH hosts', () => {
  expect(ownershipAppliesForOneRelayChange(20)).toBe(1)
  expect(ownershipAppliesForOneRelayChange(200)).toBe(1)
})
