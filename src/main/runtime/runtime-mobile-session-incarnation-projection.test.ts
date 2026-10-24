import { projectSessionTabAgentStatus } from './rpc/methods/session-tab-agent-status-projection'
import { expect, it, vi } from 'vitest'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

it.each(['pty', 'leaf', 'unknown', 'disconnected'] as const)(
  'publishes only the handle-owning incarnation for %s',
  (kind) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: projection reads only ptyId, connected and incarnationId from the record.
    const pty = {
      ptyId: 'live-pty',
      connected: kind !== 'disconnected',
      incarnationId: kind === 'unknown' ? null : 'live-incarnation'
    } as RuntimePtyWorktreeRecord
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every host member this projection path calls.
    const host = {
      tabs: new Map(),
      leaves: new Map(kind === 'leaf' ? [['leaf', { ptyId: pty.ptyId, connected: true }]] : []),
      ptysById: new Map([[pty.ptyId, pty]]),
      getLiveBrowserTabs: () => new Map(),
      getProviderSessionRows: () => [],
      getProviderSessionSnapshot: () => [],
      getLeafKey: () => 'leaf',
      findPty: () => pty,
      getRetainedStatus: () => null,
      getTrackedTitle: () => null,
      getTitleDisplayClear: () => null,
      issuePtyHandle: vi.fn(() => 'handle'),
      recordPty: vi.fn(() => pty),
      buildPtyStatus: () => ({}),
      sanitizeGroups: () => [],
      pruneGroupLayout: () => null,
      collectTabIds: () => new Set()
    } as unknown as RuntimeMobileSessionProjectionHost
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one terminal tab is the only snapshot field this projection path reads.
    const snapshot = {
      worktree: 'workspace',
      publicationEpoch: 'headless:epoch',
      tabs: [
        {
          type: 'terminal',
          id: 'tab::leaf',
          parentTabId: 'tab',
          leafId: 'leaf',
          ptyId: 'stale-pty',
          incarnationId: 'stale-incarnation',
          title: 'Shell',
          isActive: true
        }
      ]
    } as RuntimeMobileSessionTabsSnapshot

    const projected = projectRuntimeMobileSessionTabs(snapshot, host)
    const tab = projected.tabs[0]
    if (kind === 'pty' || kind === 'leaf') {
      expect(tab).not.toHaveProperty('terminalInterface')
      expect(tab).not.toHaveProperty('agentStatus')
      const old = projectSessionTabAgentStatus(projected, 'mobile', []).tabs[0]
      expect(old).not.toHaveProperty('terminalInterface')
      const modern = projectSessionTabAgentStatus(projected, 'mobile', ['terminal.interface.v1'])
        .tabs[0]
      expect(modern).not.toHaveProperty('terminalInterface')
    }

    if (kind === 'unknown' || kind === 'disconnected') {
      expect(tab).not.toHaveProperty('incarnationId')
    } else {
      expect(tab).toHaveProperty('incarnationId', 'live-incarnation')
    }
    expect(tab).toHaveProperty('status', kind === 'disconnected' ? 'pending-handle' : 'ready')
    if (kind !== 'disconnected') {
      expect(host.issuePtyHandle).toHaveBeenCalledWith(pty)
    }
  }
)
