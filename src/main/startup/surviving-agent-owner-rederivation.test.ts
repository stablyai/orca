import { describe, expect, it, vi } from 'vitest'
import {
  SURVIVING_OWNER_CAPTURE_CONCURRENCY,
  rederiveSurvivingAgentOwners
} from './surviving-agent-owner-rederivation'
import type { SessionInfo } from '../daemon/types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'

const WORKTREE = 'repo::/tmp/surviving'
const TAB = '50000000-0000-4000-8000-000000000001'
const leaves = ['50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003']
const owner = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const

function session(sessionId: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the re-derivation reads only id, liveness, incarnation and WSL distro.
  return { sessionId, isAlive: true, incarnationId: 'inc-1', ...overrides } as SessionInfo
}

describe('owners of terminals that survived a restart, at startup', () => {
  it('re-derives every surviving bound session from one shared table, and nothing else', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the persisted surface index reads.
    const workspace = {
      tabsByWorktree: { [WORKTREE]: [{ id: TAB }] },
      terminalLayoutsByTabId: {
        [TAB]: { ptyIdsByLeafId: { [leaves[0]]: 'pty-bound', [leaves[1]]: 'pty-replaced' } }
      },
      terminalPtyIncarnationsByPaneKey: {
        [makePaneKey(TAB, leaves[0])]: 'inc-1',
        [makePaneKey(TAB, leaves[1])]: 'inc-old'
      }
    } as unknown as WorkspaceSessionState
    const capture = vi.fn(async () => owner)
    const admit = vi.fn(async () => {})
    await rederiveSurvivingAgentOwners({
      listSessions: async () => [
        session('pty-bound'),
        session('pty-replaced'),
        session('pty-unbound'),
        session('pty-wsl', { wslDistro: 'Ubuntu' }),
        session('pty-dead', { isAlive: false })
      ],
      readWorkspaceSession: () => workspace,
      capture,
      admit
    })
    expect(capture).toHaveBeenCalledExactlyOnceWith('pty-bound', {
      snapshotNotBeforeMs: expect.any(Number)
    })
    expect(admit).toHaveBeenCalledExactlyOnceWith(
      {
        paneKey: makePaneKey(TAB, leaves[0]),
        connectionId: null,
        worktreeId: WORKTREE,
        tabId: TAB
      },
      owner
    )
  })

  it('captures surviving sessions a few at a time', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `pty-${i}`)
    const leafIds = ids.map((_, i) => `60000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the persisted surface index reads.
    const workspace = {
      tabsByWorktree: { [WORKTREE]: [{ id: TAB }] },
      terminalLayoutsByTabId: {
        [TAB]: { ptyIdsByLeafId: Object.fromEntries(leafIds.map((leaf, i) => [leaf, ids[i]])) }
      },
      terminalPtyIncarnationsByPaneKey: Object.fromEntries(
        leafIds.map((leaf) => [makePaneKey(TAB, leaf), 'inc-1'])
      )
    } as unknown as WorkspaceSessionState
    let inFlight = 0
    let peak = 0
    const capture = vi.fn(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return owner
    })
    const admit = vi.fn(async () => {})
    await rederiveSurvivingAgentOwners({
      listSessions: async () => ids.map((id) => session(id)),
      readWorkspaceSession: () => workspace,
      capture,
      admit
    })
    expect(capture).toHaveBeenCalledTimes(12)
    expect(admit).toHaveBeenCalledTimes(12)
    expect(peak).toBe(SURVIVING_OWNER_CAPTURE_CONCURRENCY)
  })

  it('keeps re-deriving the rest when admits throw', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `pty-${i}`)
    const leafIds = ids.map((_, i) => `70000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the persisted surface index reads.
    const workspace = {
      tabsByWorktree: { [WORKTREE]: [{ id: TAB }] },
      terminalLayoutsByTabId: {
        [TAB]: { ptyIdsByLeafId: Object.fromEntries(leafIds.map((leaf, i) => [leaf, ids[i]])) }
      },
      terminalPtyIncarnationsByPaneKey: Object.fromEntries(
        leafIds.map((leaf) => [makePaneKey(TAB, leaf), 'inc-1'])
      )
    } as unknown as WorkspaceSessionState
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const admitted: string[] = []
    const admit = vi.fn(async (scope: { paneKey: string }) => {
      if (admitted.length < 4) {
        admitted.push('failed')
        throw new Error('owner listener threw')
      }
      admitted.push(scope.paneKey)
    })
    await rederiveSurvivingAgentOwners({
      listSessions: async () => ids.map((id) => session(id)),
      readWorkspaceSession: () => workspace,
      capture: async () => owner,
      admit
    })
    expect(admit).toHaveBeenCalledTimes(5)
    expect(admitted.at(-1)).toBe(makePaneKey(TAB, leafIds[4]))
    expect(warn).toHaveBeenCalledTimes(4)
    warn.mockRestore()
  })

  it('does nothing when the daemon cannot list its sessions', async () => {
    const capture = vi.fn()
    await rederiveSurvivingAgentOwners({
      listSessions: async () => null,
      readWorkspaceSession: () => undefined,
      capture,
      admit: vi.fn()
    })
    expect(capture).not.toHaveBeenCalled()
  })
})
