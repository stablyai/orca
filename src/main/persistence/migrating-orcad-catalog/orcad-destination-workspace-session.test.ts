import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
  type PersistedClientHostedBrowserPage
} from '../../../shared/client-hosted-browser-page-record'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { prepareOrcadMigrationWorkspaceSession } from './orcad-destination-workspace-session'

const OWNER = 'repo-1::/srv/worktree'
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function layout(leafId = LEAF): TerminalLayoutSnapshot {
  return { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
}

function page(browserPageId: string): PersistedClientHostedBrowserPage {
  return {
    v: CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
    browserPageId,
    workspaceId: 'browser-workspace-1',
    browserProfileId: 'profile-1',
    url: 'https://example.test/',
    title: 'Example',
    pairedDeviceId: 'device-1',
    savedAt: 1
  }
}

function state(): PersistedState {
  return getDefaultPersistedState('/tmp/orca-test')
}

function incoming(pages: ReturnType<typeof page>[]): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    clientHostedBrowserPagesByWorktree: { [OWNER]: pages }
  }
}

describe('destination workspace-session merge validation', () => {
  it('accepts a unique client-hosted page identity', () => {
    expect(() =>
      prepareOrcadMigrationWorkspaceSession(incoming([page('page-1')]), state())
    ).not.toThrow()
  })

  it('rejects duplicate client-hosted page identities before merge', () => {
    expect(() =>
      prepareOrcadMigrationWorkspaceSession(incoming([page('page-1'), page('page-1')]), state())
    ).toThrow('orcad_migration_dormant_id_conflict:workspace_session:client-browser-page:page-1')
  })

  it.each(['existing', 'incoming'] as const)(
    'rejects a pane identity already claimed by another %s tab without mutation',
    (location) => {
      const current = state()
      const next = incoming([])
      next.terminalLayoutsByTabId['incoming-tab'] = layout()
      const competing = location === 'existing' ? current.workspaceSession : next
      competing.terminalLayoutsByTabId['other-tab'] = layout()
      const before = structuredClone({ current, next })
      expect(() => prepareOrcadMigrationWorkspaceSession(next, current)).toThrow(
        `orcad_migration_dormant_id_conflict:workspace_session:terminal-leaf:${LEAF}`
      )
      expect({ current, next }).toEqual(before)
    }
  )

  it('rejects duplicate leaves within an incoming split', () => {
    const next = incoming([])
    next.terminalLayoutsByTabId.tab = {
      ...layout(),
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF },
        second: { type: 'leaf', leafId: LEAF }
      }
    }
    expect(() => prepareOrcadMigrationWorkspaceSession(next, state())).toThrow(
      `orcad_migration_dormant_id_conflict:workspace_session:terminal-leaf:${LEAF}`
    )
  })

  it.each([
    'ptyIdsByLeafId',
    'buffersByLeafId',
    'scrollbackRefsByLeafId',
    'titlesByLeafId'
  ] as const)('preserves a competing pane claim in %s even outside its topology', (field) => {
    const current = state()
    current.workspaceSession.terminalLayoutsByTabId.other = {
      ...layout(OTHER_LEAF),
      [field]: { [LEAF]: 'preserved-value' }
    }
    const next = incoming([])
    next.terminalLayoutsByTabId.tab = layout()
    const before = structuredClone(current)
    expect(() => prepareOrcadMigrationWorkspaceSession(next, current)).toThrow(
      `orcad_migration_dormant_id_conflict:workspace_session:terminal-leaf:${LEAF}`
    )
    expect(current).toEqual(before)
  })

  it('preserves a unique split and accepts an exact retry with per-pane records', () => {
    const next = incoming([])
    next.terminalLayoutsByTabId.tab = {
      ...layout(),
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', leafId: LEAF },
        second: { type: 'leaf', leafId: OTHER_LEAF }
      },
      buffersByLeafId: { [LEAF]: 'first output', [OTHER_LEAF]: 'second output' },
      titlesByLeafId: { [LEAF]: 'first', [OTHER_LEAF]: 'second' }
    }
    const current = state()
    const prepared = prepareOrcadMigrationWorkspaceSession(next, current)
    expect(prepared.merged?.terminalLayoutsByTabId).toEqual(next.terminalLayoutsByTabId)
    current.workspaceSession = prepared.merged!
    expect(prepareOrcadMigrationWorkspaceSession(next, current).merged).toEqual(
      current.workspaceSession
    )
  })
})
