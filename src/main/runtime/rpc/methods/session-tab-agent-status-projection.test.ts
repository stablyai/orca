import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY
} from '../../../../shared/protocol-version'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-types'
import {
  CLAUDE_STRUCTURED_CHAT_DESKTOP_ONLY_TAB_TITLE,
  STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE,
  projectSessionTabAgentStatus
} from './session-tab-agent-status-projection'

function makeSnapshot(sessionBoundary: boolean): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        title: 'Claude',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        isActive: true,
        agentStatus: {
          state: 'done',
          prompt: '',
          updatedAt: 100,
          stateStartedAt: 100,
          paneKey: 'tab-1:leaf-1',
          stateHistory: [],
          sessionBoundary
        }
      }
    ]
  }
}

describe('projectSessionTabAgentStatus', () => {
  it('projects structured tabs and dangling group focus out of old clients', () => {
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      ...makeSnapshot(false),
      activeGroupId: 'group-a',
      activeTabId: 'agent-session:session-a',
      activeTabType: 'agent-session',
      tabGroups: [
        {
          id: 'group-a',
          activeTabId: 'agent-session:session-a',
          tabOrder: ['tab-1::leaf-1', 'agent-session:session-a'],
          recentTabIds: ['agent-session:session-a', 'tab-1::leaf-1']
        },
        {
          id: 'group-b',
          activeTabId: 'agent-session:session-b',
          tabOrder: ['agent-session:session-b']
        }
      ],
      tabGroupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-a' },
        second: { type: 'leaf', groupId: 'group-b' }
      },
      tabs: [
        { ...makeSnapshot(false).tabs[0]!, isActive: false },
        {
          type: 'agent-session',
          id: 'agent-session:session-a',
          title: 'Codex Chat',
          sessionId: 'session-a',
          agent: 'codex',
          isActive: true
        },
        {
          type: 'agent-session',
          id: 'agent-session:session-b',
          title: 'Codex Chat',
          sessionId: 'session-b',
          agent: 'codex',
          isActive: false
        }
      ]
    }
    // A paired client that never negotiated the capability: mobile keeps an unrenderable row under
    // a fallback title, so only a non-mobile old client still loses them.
    const oldClient = projectSessionTabAgentStatus(snapshot, 'runtime', [])
    expect(oldClient.tabs.map((tab) => tab.type)).toEqual(['terminal'])
    expect(oldClient.activeTabId).toBe('tab-1::leaf-1')
    expect(oldClient.activeTabType).toBe('terminal')
    expect(oldClient.tabs[0]?.isActive).toBe(true)
    expect(oldClient.tabGroups?.[0]?.tabOrder).toEqual(['tab-1::leaf-1'])
    expect(oldClient.tabGroups).toHaveLength(1)
    expect(oldClient.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'group-a' })

    const capableMobile = projectSessionTabAgentStatus(snapshot, 'mobile', [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
    expect(capableMobile).toBe(snapshot)

    const capable = projectSessionTabAgentStatus(snapshot, 'runtime', [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
    expect(capable).toBe(snapshot)

    // The in-process caller is the host's own build and negotiates nothing.
    expect(projectSessionTabAgentStatus(snapshot, undefined, undefined)).toBe(snapshot)
  })

  const claudeSnapshot = {
    ...makeSnapshot(false),
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:codex',
        title: 'Codex Chat',
        sessionId: 'codex',
        agent: 'codex',
        isActive: true
      },
      {
        type: 'agent-session',
        id: 'agent-session:claude',
        title: 'Claude Chat',
        sessionId: 'claude',
        agent: 'claude',
        isActive: false
      }
    ],
    activeGroupId: 'group-a',
    activeTabId: 'agent-session:codex',
    activeTabType: 'agent-session',
    tabGroups: [
      { id: 'group-a', activeTabId: 'agent-session:codex', tabOrder: ['agent-session:codex'] },
      { id: 'group-b', activeTabId: 'agent-session:claude', tabOrder: ['agent-session:claude'] }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-a' },
      second: { type: 'leaf', groupId: 'group-b' }
    }
  } as unknown as RuntimeMobileSessionTabsSnapshot

  const structuredMobile = [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
  ]

  it('withholds Claude rows from a paired runtime client that never negotiated them', () => {
    const projected = projectSessionTabAgentStatus(claudeSnapshot, 'runtime', [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])

    expect(projected.tabs.map((tab) => tab.id)).toEqual(['agent-session:codex'])
    // A row pruned from `tabs` but left in the layout is its own dead tab.
    expect(projected.tabGroups?.map((group) => group.id)).toEqual(['group-a'])
    expect(projected.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'group-a' })
    expect(projected.activeGroupId).toBe('group-a')
    expect(projected.activeTabId).toBe('agent-session:codex')
    expect(projected.activeTabType).toBe('agent-session')
  })

  it('uses a desktop fallback for an unsupported Claude row instead of withholding it', () => {
    const projected = projectSessionTabAgentStatus(claudeSnapshot, 'mobile', [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])

    // The row survives so the chat the desktop shows is not simply absent on the phone.
    expect(projected.tabs.map((tab) => tab.id)).toEqual([
      'agent-session:codex',
      'agent-session:claude'
    ])
    expect(projected.tabs.map((tab) => tab.title)).toEqual([
      'Codex Chat',
      CLAUDE_STRUCTURED_CHAT_DESKTOP_ONLY_TAB_TITLE
    ])
    // Nothing is removed, so the layout it belonged to is untouched.
    expect(projected.tabGroups?.map((group) => group.id)).toEqual(['group-a', 'group-b'])
    expect(projected.tabGroupLayout).toEqual(claudeSnapshot.tabGroupLayout)
    expect(projected.activeTabId).toBe('agent-session:codex')
  })

  it('projects agent-specific fallback titles for a mobile client with no capabilities', () => {
    const projected = projectSessionTabAgentStatus(claudeSnapshot, 'mobile', [])

    expect(projected.tabs.map((tab) => tab.title)).toEqual([
      STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE,
      CLAUDE_STRUCTURED_CHAT_DESKTOP_ONLY_TAB_TITLE
    ])
    expect(projected.tabGroupLayout).toEqual(claudeSnapshot.tabGroupLayout)
  })

  it('does not treat the Claude capability as a substitute for the base structured capability', () => {
    const projected = projectSessionTabAgentStatus(claudeSnapshot, 'mobile', [
      CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])

    expect(projected.tabs.map((tab) => tab.title)).toEqual([
      STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE,
      CLAUDE_STRUCTURED_CHAT_DESKTOP_ONLY_TAB_TITLE
    ])
  })

  it('shows both real titles once mobile negotiates Claude', () => {
    expect(projectSessionTabAgentStatus(claudeSnapshot, 'mobile', structuredMobile)).toBe(
      claudeSnapshot
    )
  })

  // Why: updating cannot reveal a chat the desktop is not serving, so the prompt would lie.
  it('never emits an empty structured tab title', () => {
    for (const capabilities of [[], [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]]) {
      const projected = projectSessionTabAgentStatus(claudeSnapshot, 'mobile', capabilities)
      for (const tab of projected.tabs) {
        expect(tab.title.length).toBeGreaterThan(0)
      }
    }
  })

  it.each([
    ['mobile', 'mobile' as const, structuredMobile],
    [
      'runtime',
      'runtime' as const,
      [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      ]
    ]
  ])(
    'publishes Claude rows to a paired %s client that negotiated them',
    (_name, clientKind, capabilities) => {
      const projected = projectSessionTabAgentStatus(claudeSnapshot, clientKind, capabilities)

      expect(projected).toBe(claudeSnapshot)
      expect(projected.tabGroupLayout).toEqual(claudeSnapshot.tabGroupLayout)
    }
  )

  it('keeps Claude rows on the local renderer, which negotiates nothing', () => {
    expect(projectSessionTabAgentStatus(claudeSnapshot, undefined, undefined)).toBe(claudeSnapshot)
    expect(projectSessionTabAgentStatus(claudeSnapshot, undefined, [])).toBe(claudeSnapshot)
  })

  it('leaves Codex rows untouched whether or not the Claude capability is present', () => {
    const codexOnly = {
      ...claudeSnapshot,
      tabs: claudeSnapshot.tabs.filter((tab) => tab.id !== 'agent-session:claude'),
      tabGroups: claudeSnapshot.tabGroups?.filter((group) => group.id !== 'group-b'),
      tabGroupLayout: { type: 'leaf', groupId: 'group-a' }
    } as unknown as RuntimeMobileSessionTabsSnapshot

    for (const capabilities of [[STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY], structuredMobile]) {
      for (const clientKind of ['mobile', 'runtime'] as const) {
        expect(projectSessionTabAgentStatus(codexOnly, clientKind, capabilities)).toBe(codexOnly)
      }
    }
    expect(projectSessionTabAgentStatus(codexOnly, undefined, undefined)).toBe(codexOnly)
  })

  it('withholds session boundaries from legacy paired clients', () => {
    const projected = projectSessionTabAgentStatus(makeSnapshot(true), 'runtime', [])

    expect(projected.tabs[0]).not.toHaveProperty('agentStatus')
  })

  it('publishes session boundaries to clients that negotiated them', () => {
    const snapshot = makeSnapshot(true)

    expect(
      projectSessionTabAgentStatus(snapshot, 'runtime', [AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY])
    ).toBe(snapshot)
  })

  it('does not alter local, mobile, or real-completion projections', () => {
    const localBoundary = makeSnapshot(true)
    const mobileBoundary = makeSnapshot(true)
    const runtimeCompletion = makeSnapshot(false)

    expect(projectSessionTabAgentStatus(localBoundary, undefined, undefined)).toBe(localBoundary)
    expect(projectSessionTabAgentStatus(mobileBoundary, 'mobile', [])).toBe(mobileBoundary)
    expect(projectSessionTabAgentStatus(runtimeCompletion, 'runtime', [])).toBe(runtimeCompletion)
  })
})

describe('projectSessionTabAgentStatus legacy phone conversation fold', () => {
  const providerSession = {
    key: 'session_id' as const,
    id: 'codex-session',
    transcriptPath: '/r.jsonl'
  }
  const fold: AgentStatusEntry = {
    state: 'done',
    sessionBoundary: true,
    prompt: '',
    updatedAt: 1234,
    stateStartedAt: 1234,
    stateHistory: [],
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    terminalTitle: 'Say hi | my-repo',
    agentType: 'codex',
    providerSession,
    model: 'gpt-5.5',
    worktreeId: 'wt-1'
  }

  function statuslessSnapshot(
    conversation: Record<string, unknown> = {}
  ): RuntimeMobileSessionTabsSnapshot {
    return {
      ...makeSnapshot(false),
      tabs: [
        {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          title: 'Say hi | my-repo',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          isActive: true,
          ...conversation
        }
      ]
    }
  }

  const offered = {
    conversationIdentity: {
      agentType: 'codex',
      providerSession,
      model: 'gpt-5.5',
      capturedAt: 1234,
      source: 'live'
    },
    conversationOfferedWithoutStatus: true
  }

  it.each([undefined, [AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY]])(
    'folds an offered identity into a capability-less phone status, without the members it never reads (capabilities %j)',
    (capabilities) => {
      const projected = projectSessionTabAgentStatus(
        statuslessSnapshot(offered),
        'mobile',
        capabilities
      )
      expect(projected.tabs[0]).toEqual({ ...statuslessSnapshot().tabs[0], agentStatus: fold })
      expect(projected.tabs[0]).not.toHaveProperty('conversationIdentity')
      expect(projected.tabs[0]).not.toHaveProperty('conversationOfferedWithoutStatus')
    }
  )

  it.each([
    ['mobile', [TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY]],
    ['runtime', undefined],
    ['runtime', [AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY]],
    [undefined, undefined]
  ] as const)('gives a %s client the field and no status (capabilities %j)', (kind, caps) => {
    const snapshot = statuslessSnapshot(offered)
    expect(projectSessionTabAgentStatus(snapshot, kind, caps)).toEqual(snapshot)
  })

  it.each([
    ['no offer', { conversationIdentity: offered.conversationIdentity }],
    [
      'a null identity (read as absent)',
      { conversationIdentity: null, conversationOfferedWithoutStatus: true }
    ],
    [
      'a malformed identity',
      { conversationIdentity: { agentType: 'codex' }, conversationOfferedWithoutStatus: true }
    ],
    ['no identity', { conversationOfferedWithoutStatus: true }]
  ])('never folds with %s', (_name, conversation) => {
    const snapshot = statuslessSnapshot(conversation)
    expect(projectSessionTabAgentStatus(snapshot, 'mobile', undefined)).toEqual(snapshot)
  })

  it.each(['mobile', 'runtime', undefined] as const)(
    'leaves a genuine status untouched for a %s client',
    (kind) => {
      const genuine = makeSnapshot(false)
      const withField = {
        ...genuine,
        tabs: genuine.tabs.map((tab) => ({ ...tab, ...offered }))
      }
      const expected = projectSessionTabAgentStatus(genuine, kind, undefined)
      expect(projectSessionTabAgentStatus(withField, kind, undefined)).toEqual({
        ...expected,
        tabs: expected.tabs.map((tab) => ({ ...tab, ...offered }))
      })
    }
  )

  it('returns a frame with nothing to fold as is, allocating nothing', () => {
    const snapshot = statuslessSnapshot()
    expect(projectSessionTabAgentStatus(snapshot, 'mobile', undefined)).toBe(snapshot)
  })

  it('projects one shared payload for every audience without mutating it', () => {
    const shared = statuslessSnapshot(offered)
    const before = structuredClone(shared)
    const outputs = (['runtime', 'mobile', 'mobile', 'runtime'] as const).map((kind) =>
      projectSessionTabAgentStatus(shared, kind, undefined)
    )

    expect(shared).toEqual(before)
    expect(
      outputs.map((output) => output.tabs[0]?.type === 'terminal' && output.tabs[0].agentStatus)
    ).toEqual([undefined, fold, fold, undefined])
    expect(outputs.map((output) => 'conversationIdentity' in (output.tabs[0] ?? {}))).toEqual([
      true,
      false,
      false,
      true
    ])
    expect(projectSessionTabAgentStatus(shared, 'mobile', undefined).tabs[0]).not.toBe(
      shared.tabs[0]
    )
  })

  it('survives a JSON round trip: the folded frame names the address only in its status', () => {
    const wire = JSON.parse(
      JSON.stringify(projectSessionTabAgentStatus(statuslessSnapshot(offered), 'mobile', undefined))
    )
    expect(wire.tabs[0]).toEqual(
      JSON.parse(JSON.stringify({ ...statuslessSnapshot().tabs[0], agentStatus: fold }))
    )
  })
})
