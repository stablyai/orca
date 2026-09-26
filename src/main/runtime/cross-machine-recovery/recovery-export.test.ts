import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  MAX_RECOVERY_DESCRIPTOR_BYTES,
  type RecoveryLayout
} from '../../../shared/cross-machine-recovery-descriptor'
import type { Repo } from '../../../shared/repo-types'
import { OrcaRecoveryDescriptorV1Schema } from '../../../shared/rpc-contract/cross-machine-recovery-params'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  buildRecoveryDescriptor,
  fitRecoveryDescriptor,
  type RecoveryExportSources
} from './recovery-export'

const W = 'repo-1::/work/repo'
const T1 = 'terminal-tab-1'
const G1 = 'group-1'
const G2 = 'group-2'
const B1 = 'browser-1'
const EDITOR_TAB = '/work/repo/src/a.ts'
const L1 = '11111111-1111-4111-8111-111111111111'
const L2 = '22222222-2222-4222-8222-222222222222'
const L3 = '33333333-3333-4333-8333-333333333333'

const repo: Repo = {
  id: 'repo-1',
  path: '/work/repo',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

const worktree: Worktree = {
  id: W,
  instanceId: 'instance-1',
  repoId: 'repo-1',
  path: '/work/repo',
  head: 'abc',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: true,
  displayName: 'feature',
  comment: 'note',
  linkedIssue: 12,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: true,
  sortOrder: 0,
  lastActivityAt: 900
}

function browserPage(id: string, url: string, title: string) {
  return {
    id,
    workspaceId: B1,
    worktreeId: W,
    url,
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 10
  }
}

function session(): WorkspaceSessionState {
  const sleeping: SleepingAgentSessionRecord[] = [
    {
      paneKey: `${T1}:${L3}`,
      tabId: T1,
      worktreeId: W,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-shared' },
      prompt: 'old prompt',
      state: 'done',
      capturedAt: 100,
      updatedAt: 100
    },
    {
      paneKey: `${T1}:${L2}`,
      tabId: T1,
      worktreeId: W,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'sess-sleep' },
      prompt: 'sleeping prompt',
      state: 'waiting',
      capturedAt: 200,
      updatedAt: 300,
      launchConfig: {
        agentArgs: '--full-auto',
        agentEnv: { CODEX_HOME: '/secret/codex-home', FOO: 'bar' }
      },
      origin: 'quit'
    }
  ]
  return {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {
      [W]: [
        {
          id: T1,
          entityId: T1,
          groupId: G1,
          worktreeId: W,
          executionHostId: 'local',
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        },
        {
          id: EDITOR_TAB,
          entityId: EDITOR_TAB,
          groupId: G1,
          worktreeId: W,
          contentType: 'editor',
          label: 'a.ts',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 2
        },
        {
          id: 'browser-tab-1',
          entityId: B1,
          groupId: G2,
          worktreeId: W,
          contentType: 'browser',
          label: 'Docs',
          customLabel: null,
          color: null,
          sortOrder: 2,
          createdAt: 3
        }
      ]
    },
    tabGroups: {
      [W]: [
        { id: G1, worktreeId: W, activeTabId: T1, tabOrder: [T1, EDITOR_TAB] },
        { id: G2, worktreeId: W, activeTabId: 'browser-tab-1', tabOrder: ['browser-tab-1'] }
      ]
    },
    tabGroupLayouts: {
      [W]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.3,
        first: { type: 'leaf', groupId: G1 },
        second: { type: 'leaf', groupId: G2 }
      }
    },
    activeGroupIdByWorktree: { [W]: G1 },
    tabsByWorktree: {
      [W]: [
        {
          id: T1,
          ptyId: 'pty-live-1',
          worktreeId: W,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          generation: 3,
          startupCwd: '/work/repo/packages/app'
        }
      ]
    },
    terminalLayoutsByTabId: {
      [T1]: {
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', leafId: L1 },
          second: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.25,
            first: { type: 'leaf', leafId: L2 },
            second: { type: 'leaf', leafId: L3 }
          }
        },
        activeLeafId: L2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [L1]: 'pty-live-1' },
        buffersByLeafId: { [L1]: 'SCROLLBACK-SECRET' },
        scrollbackRefsByLeafId: { [L1]: 'scrollback-ref-1' },
        titlesByLeafId: { [L1]: 'claude' }
      }
    },
    openFilesByWorktree: {
      [W]: [
        {
          filePath: EDITOR_TAB,
          relativePath: 'src/a.ts',
          worktreeId: W,
          language: 'typescript',
          isPreview: false,
          dirtyDraftContent: 'DRAFT-SECRET'
        }
      ]
    },
    activeFileIdByWorktree: { [W]: EDITOR_TAB },
    browserTabsByWorktree: {
      [W]: [{ ...browserPage(B1, 'https://b.example', 'B'), label: 'Docs', activePageId: 'page-2' }]
    },
    browserPagesByWorkspace: {
      [B1]: [
        browserPage('page-1', 'https://a.example', 'A'),
        browserPage('page-2', 'https://b.example', 'B')
      ]
    },
    activeBrowserTabIdByWorktree: { [W]: B1 },
    activeTabTypeByWorktree: { [W]: 'terminal' },
    activeTabIdByWorktree: { [W]: T1 },
    sleepingAgentSessionsByPaneKey: Object.fromEntries(sleeping.map((r) => [r.paneKey, r]))
  }
}

const liveRow: AgentStatusIpcPayload = {
  state: 'working',
  prompt: 'live prompt',
  agentType: 'claude',
  model: 'opus',
  paneKey: `${T1}:${L1}`,
  tabId: T1,
  worktreeId: W,
  connectionId: null,
  receivedAt: 5_000,
  stateStartedAt: 4_000,
  providerSession: { key: 'session_id', id: 'sess-shared' }
}

function sources(overrides: Partial<RecoveryExportSources> = {}): RecoveryExportSources {
  return {
    now: 10_000,
    source: {
      runtimeId: 'runtime-1',
      appVersion: '1.4.212',
      machineName: 'studio',
      platform: 'darwin',
      executionHostId: 'local'
    },
    repo,
    worktree,
    session: session(),
    liveStatuses: [liveRow],
    structuredRecords: [],
    presentation: { views: [], preferredClientKey: null },
    ...overrides
  }
}

const expectedLayout: RecoveryLayout = {
  tabs: [
    {
      id: T1,
      entityId: T1,
      groupId: G1,
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    {
      id: EDITOR_TAB,
      entityId: EDITOR_TAB,
      groupId: G1,
      contentType: 'editor',
      label: 'a.ts',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: 2
    },
    {
      id: 'browser-tab-1',
      entityId: B1,
      groupId: G2,
      contentType: 'browser',
      label: 'Docs',
      customLabel: null,
      color: null,
      sortOrder: 2,
      createdAt: 3
    }
  ],
  groups: [
    { id: G1, activeTabId: T1, tabOrder: [T1, EDITOR_TAB] },
    { id: G2, activeTabId: 'browser-tab-1', tabOrder: ['browser-tab-1'] }
  ],
  groupLayout: {
    type: 'split',
    direction: 'horizontal',
    ratio: 0.3,
    first: { type: 'leaf', groupId: G1 },
    second: { type: 'leaf', groupId: G2 }
  },
  activeGroupId: G1,
  terminalTabs: [
    {
      id: T1,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1,
      startupCwd: '/work/repo/packages/app'
    }
  ],
  terminalLayouts: {
    [T1]: {
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', leafId: L1 },
        second: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.25,
          first: { type: 'leaf', leafId: L2 },
          second: { type: 'leaf', leafId: L3 }
        }
      },
      activeLeafId: L2,
      expandedLeafId: null,
      titlesByLeafId: { [L1]: 'claude' }
    }
  },
  startupCwdRelative: { [T1]: 'packages/app' },
  editors: [{ relativePath: 'src/a.ts', language: 'typescript', isPreview: false }],
  activeEditorRelativePath: 'src/a.ts',
  browsers: [
    {
      id: B1,
      label: 'Docs',
      activePageId: 'page-2',
      pages: [
        { id: 'page-1', url: 'https://a.example', title: 'A' },
        { id: 'page-2', url: 'https://b.example', title: 'B' }
      ]
    }
  ],
  activeBrowserId: B1,
  activeTabType: 'terminal',
  activeTabId: T1
}

describe('buildRecoveryDescriptor', () => {
  it('round-trips the local layout through the strict descriptor schema', () => {
    const descriptor = buildRecoveryDescriptor(sources())
    const wire = JSON.parse(JSON.stringify(descriptor))

    expect(OrcaRecoveryDescriptorV1Schema.parse(wire)).toEqual(wire)
    expect(wire.layout).toEqual(expectedLayout)
    expect(wire.workspace).toEqual({
      worktreeId: W,
      instanceId: 'instance-1',
      path: '/work/repo',
      branch: 'refs/heads/feature',
      meta: {
        displayName: 'feature',
        comment: 'note',
        linkedIssue: 12,
        linkedPR: null,
        linkedLinearIssue: null,
        lastActivityAt: 900,
        isPinned: true
      }
    })
    expect(wire.presentation).toEqual({
      views: [],
      preferredClientKey: null,
      freshness: 'host-only'
    })
  })

  it('never exports PTY incarnations, scrollback, drafts or env values', () => {
    const serialized = JSON.stringify(buildRecoveryDescriptor(sources()))

    for (const excluded of [
      'pty-live-1',
      'SCROLLBACK-SECRET',
      'scrollback-ref-1',
      'DRAFT-SECRET',
      '/secret/codex-home',
      'ptyIdsByLeafId',
      'buffersByLeafId',
      'scrollbackRefsByLeafId',
      'dirtyDraftContent',
      'generation'
    ]) {
      expect(serialized).not.toContain(excluded)
    }
  })

  it('dedupes by binding key with live winning and lists agents v1 does not export', () => {
    const { bindings, omittedBindings } = buildRecoveryDescriptor(sources())
    expect(omittedBindings).toEqual([
      { agent: 'codex', key: 'session_id', id: 'sess-sleep', reason: 'agent-not-supported-v1' }
    ])

    expect(bindings).toEqual([
      {
        sourcePaneKey: `${T1}:${L1}`,
        sourceTabId: T1,
        sourceLeafId: L1,
        surface: 'terminal',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-shared' },
        liveness: 'live',
        state: 'working',
        launch: { launchPreferences: { model: 'opus' }, sourceAgentArgs: null, sourceEnvKeys: [] },
        prompt: 'live prompt',
        capturedAt: 10_000,
        updatedAt: 5_000,
        lastHumanInputAt: null
      }
    ])
  })

  it('carries the structured Claude cursor for agent-session tabs', () => {
    const record = agentSessionRecordFixture()
    const structured = {
      ...record,
      location: { ...record.location, workspaceId: W },
      options: { model: 'sonnet', effort: 'high' },
      providerHandleChain: [
        {
          ...record.providerHandleChain[0],
          handle: { provider: 'claude' as const, sessionId: 'claude-sess', leafUuid: 'leaf-uuid-9' }
        }
      ]
    }

    const { bindings } = buildRecoveryDescriptor(
      sources({
        liveStatuses: [],
        structuredRecords: [{ record: structured, tabId: 'agent-tab-1' }]
      })
    )

    expect(bindings.find((binding) => binding.surface === 'structured')).toEqual({
      sourcePaneKey: 'agent-tab-1',
      sourceTabId: 'agent-tab-1',
      sourceLeafId: null,
      surface: 'structured',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-sess' },
      structuredCursor: { provider: 'claude', sessionId: 'claude-sess', leafUuid: 'leaf-uuid-9' },
      liveness: 'sleeping',
      state: 'done',
      launch: {
        launchPreferences: { model: 'sonnet', effort: 'high' },
        sourceAgentArgs: null,
        sourceEnvKeys: [],
        accountHomeVariable: 'CLAUDE_CONFIG_DIR'
      },
      capturedAt: 10_000,
      updatedAt: record.updatedAt,
      lastHumanInputAt: null
    })
  })
})

describe('fitRecoveryDescriptor', () => {
  it('drops browser page lists before refusing an oversized descriptor', () => {
    const descriptor = buildRecoveryDescriptor(sources())
    const hugeTitle = 'x'.repeat(MAX_RECOVERY_DESCRIPTOR_BYTES)
    const oversized = {
      ...descriptor,
      layout: {
        ...descriptor.layout,
        browsers: descriptor.layout.browsers.map((browser) => ({
          ...browser,
          pages: [{ id: 'page-huge', url: 'https://huge.example', title: hugeTitle }]
        }))
      }
    }

    const fitted = fitRecoveryDescriptor(oversized)

    expect(fitted.layout.browsers).toEqual([
      { id: B1, label: 'Docs', activePageId: 'page-2', pages: [] }
    ])
    expect(fitted.layout.terminalTabs).toEqual(descriptor.layout.terminalTabs)
  })

  it('refuses a descriptor that stays too large without browser pages', () => {
    const descriptor = buildRecoveryDescriptor(sources())
    const oversized = {
      ...descriptor,
      workspace: {
        ...descriptor.workspace,
        meta: { ...descriptor.workspace.meta, comment: 'x'.repeat(MAX_RECOVERY_DESCRIPTOR_BYTES) }
      }
    }

    expect(() => fitRecoveryDescriptor(oversized)).toThrow('recovery_descriptor_too_large')
  })

  it('keeps distinct agents that share a bare provider session id', () => {
    const base = sources()
    const records = base.session.sleepingAgentSessionsByPaneKey ?? {}
    const codex = Object.values(records).find((record) => record.agent === 'codex')
    expect(codex).toBeDefined()
    const twin = { ...codex!, agent: 'claude' as const }
    const { bindings, omittedBindings } = buildRecoveryDescriptor({
      ...base,
      session: { ...base.session, sleepingAgentSessionsByPaneKey: { ...records, twin } }
    })
    expect(
      bindings.filter((b) => b.providerSession.id === 'sess-sleep').map((b) => b.agent)
    ).toEqual(['claude'])
    expect(omittedBindings.map((b) => `${b.agent}:${b.id}`)).toEqual(['codex:sess-sleep'])
  })
})
