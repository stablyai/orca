import { expect, it, vi } from 'vitest'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

it.each(['pty', 'leaf', 'unknown', 'disconnected'] as const)(
  'publishes only the handle-owning incarnation for %s',
  (kind) => {
    const pty = {
      ptyId: 'live-pty',
      connected: kind !== 'disconnected',
      incarnationId: kind === 'unknown' ? null : 'live-incarnation'
    } as RuntimePtyWorktreeRecord
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
      issuePtyHandle: vi.fn(() => 'handle'),
      recordPty: vi.fn(() => pty),
      buildPtyStatus: () => ({}),
      sanitizeGroups: () => [],
      pruneGroupLayout: () => null,
      collectTabIds: () => new Set()
    } as unknown as RuntimeMobileSessionProjectionHost
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

    const tab = projectRuntimeMobileSessionTabs(snapshot, host).tabs[0]

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
