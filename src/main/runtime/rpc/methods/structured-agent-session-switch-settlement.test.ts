import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as caller
} from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  LEAF_B
} from '../../main-owned-workspace-runtime-fixture'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { TerminalRevealUnconfirmedError } from '../../session-tabs/terminal-not-placed-error'
import { placeSwitchChat } from './structured-agent-session-switch-chat-placement'

// After a switch commits its chat's tab, the owner's answer settles it: bound to that one tab,
// never taken as a refusal when it is lost, and never placing the chat in a tab the user changed.

const owner = vi.hoisted(() => ({ main: false }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return owner.main
  }
}))

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const params = createTestParams()
  expect(
    await rig.host.create(
      caller,
      createTestParams(undefined, { location: { ...params.location, workspaceId: WORKTREE_ID } })
    )
  ).toMatchObject({ ok: true })
  setStructuredAgentSessionHost(rig.host)
  await rig.store.setSessionTabVisibility(id, false)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  owner.main = false
  vi.restoreAllMocks()
  await rig.dispose()
})

/** The user splits the switched tab between the owner's decision and its change. */
function splitBetweenDecisionAndChange(
  runtime: ReturnType<typeof setupMainOwnedWorkspace>['runtime']
) {
  const change = runtime.setSwitchedTabContent.bind(runtime)
  vi.spyOn(runtime, 'setSwitchedTabContent').mockImplementation(async (ws, request, decide) => {
    if (!decide) {
      await runtime.applyLayoutCommand({
        type: 'splitPane',
        workspace: WORKTREE_ID,
        tabId: TAB_ID,
        leafId: LEAF_A,
        direction: 'vertical',
        newLeafId: LEAF_B
      })
    }
    return change(ws, request, decide)
  })
}

it.each([
  ['main owns the layout', true, false],
  ['a windowless host', false, false],
  ['its usual tab id is taken', true, true]
])(
  'keeps a tab split after the decision and opens the chat beside it, recording where: %s',
  async (_name, main, occupied) => {
    owner.main = main
    const { runtime, session } = setupMainOwnedWorkspace()
    const usual = structuredAgentSessionTabId(id)
    if (occupied) {
      expect(
        await runtime.applyLayoutCommand({
          type: 'createTerminalTab',
          workspace: WORKTREE_ID,
          tabId: usual
        })
      ).toMatchObject({ ok: true })
    }
    splitBetweenDecisionAndChange(runtime)
    await placeSwitchChat(
      { runtime } as never,
      rig.host,
      { workspaceId: WORKTREE_ID, sessionId: id, agent: 'codex' },
      { terminalId: TAB_ID, wholeTab: true, besideTerminalId: TAB_ID },
      () => {},
      () => {}
    )
    const tabs = session().unifiedTabs?.[WORKTREE_ID] ?? []
    const chats = tabs.filter((tab) => tab.contentType === 'agent-session' && tab.entityId === id)
    expect(chats).toHaveLength(1)
    expect(chats[0]!.id).toBe(occupied ? `${usual}-2` : usual)
    expect(rig.store.getSessionTabId(id)).toBe(chats[0]!.id)
    expect(tabs.find((tab) => tab.id === TAB_ID)?.contentType).toBe('terminal')
    if (occupied) {
      expect(tabs.find((tab) => tab.id === usual)?.contentType).toBe('terminal')
    }
  }
)

const chatRequest = {
  tabId: TAB_ID,
  expectSource: { kind: 'terminal' as const, terminalId: TAB_ID },
  window: { kind: 'agent-session' as const, sessionId: 'settling-chat', agent: 'codex' as const },
  layout: { kind: 'agent-session' as const, sessionId: 'settling-chat', agent: 'codex' as const },
  focus: false
}

it.each([
  ['applied while current', { retargeted: true }, true, { kind: 'applied', tabId: TAB_ID }],
  [
    'applied, then a later close or switch',
    { retargeted: true },
    false,
    { kind: 'superseded', tabId: TAB_ID }
  ],
  [
    'applied, then the tab changed',
    { retargeted: true, superseded: true },
    true,
    { kind: 'superseded', tabId: TAB_ID }
  ],
  [
    'refused before it applied',
    { retargeted: false, tabId: 'chat-elsewhere' },
    true,
    { kind: 'refused', committed: true, destination: 'chat-elsewhere' }
  ],
  [
    'its answer lost',
    new TerminalRevealUnconfirmedError('lost'),
    true,
    { kind: 'unknown', tabId: TAB_ID }
  ]
] as const)(
  'settles a committed switch by its owner, never by time: %s',
  async (_name, answer, current, settled) => {
    const { runtime } = setupMainOwnedWorkspace()
    const asked = vi
      .spyOn(runtime, 'setSwitchedTabContent')
      .mockImplementation(async (_ws, request, decide) => {
        expect(request).toMatchObject({ operation: expect.any(String) })
        if (decide) {
          return { retargeted: true, tabId: TAB_ID, page: 'page-1' }
        }
        expect(request).toMatchObject({ tabId: TAB_ID, page: 'page-1' })
        if (answer instanceof Error) {
          throw answer
        }
        return answer
      })
    const commit = vi.fn(async () => () => current)
    await expect(runtime.switchTabContent(WORKTREE_ID, chatRequest, commit)).resolves.toEqual(
      settled
    )
    expect(commit).toHaveBeenCalledExactlyOnceWith(TAB_ID)
    // One decision and one change, the same switch: a lost answer is asked about by the relay,
    // read-only, never redone here.
    expect(asked).toHaveBeenCalledTimes(2)
    expect(asked.mock.calls[0]![1].operation).toBe(asked.mock.calls[1]![1].operation)
  }
)

// A terminal placed in the chat's tab, its answer lost: the committed record stands, nothing opens
// beside it, and nothing shows it until an answer says the switch applied while still current.
it('keeps a lost terminal answer committed, and shows it in that tab once a late answer comes', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  runtime.registerPty('settling-pty', WORKTREE_ID, null, { tabId: 'terminal-E', leafId: LEAF_B })
  let late: ((outcome: { retargeted: boolean }) => void) | undefined
  vi.spyOn(runtime, 'setSwitchedTabContent').mockImplementation(
    async (_ws, _request, decide, onLate) => {
      if (decide) {
        return { retargeted: true, tabId: TAB_ID }
      }
      late = onLate
      throw new TerminalRevealUnconfirmedError('Tab content change unanswered')
    }
  )
  const ordinary = vi.spyOn(runtime, 'applyLayoutCommand')
  const publish = vi
    .spyOn(runtime, 'publishPtyBackedMobileSessionTerminal')
    .mockImplementation(() => {})
  await expect(
    runtime.placeSwitchTerminal(WORKTREE_ID, {
      terminal: {
        handle: 'settling-handle',
        ptyId: 'settling-pty',
        tabId: 'terminal-E',
        paneKey: `terminal-E:${LEAF_B}`
      },
      chatSessionId: 'chat-S',
      chatTabId: TAB_ID,
      activate: true,
      focusWindow: false,
      commit: async () => () => true
    })
  ).resolves.toMatchObject({ retargeted: true })
  expect(publish).not.toHaveBeenCalled()
  expect(ordinary).not.toHaveBeenCalled()
  late?.({ retargeted: true })
  expect(publish).toHaveBeenCalledWith(
    WORKTREE_ID,
    expect.anything(),
    expect.objectContaining({ inTab: TAB_ID })
  )
  expect(ordinary).not.toHaveBeenCalled()
})

// The owner applied, then the user closed the new chat before its lost answer settled: the close
// stands, in both owner modes, through publication and the record.
it.each([false, true])(
  'keeps closed a chat the user closed after its switch applied (main owns the layout: %s)',
  async (main) => {
    owner.main = main
    const { runtime, session } = setupMainOwnedWorkspace()
    const real = runtime.setSwitchedTabContent.bind(runtime)
    vi.spyOn(runtime, 'setSwitchedTabContent').mockImplementation(async (ws, request, decide) => {
      const answer = await real(ws, request, decide)
      if (!decide) {
        expect(answer).toMatchObject({ retargeted: true, tabId: TAB_ID })
        await rig.host.setSessionTabVisibility(id, false)
        await runtime.applyLayoutCommand({
          type: 'closeTabs',
          workspace: WORKTREE_ID,
          tabIds: [TAB_ID],
          force: true
        })
        throw new TerminalRevealUnconfirmedError('lost reply after the user closed it')
      }
      return answer
    })
    const project = vi.spyOn(runtime, 'projectStructuredAgentSessionTab')
    await placeSwitchChat(
      { runtime } as never,
      rig.host,
      { workspaceId: WORKTREE_ID, sessionId: id, agent: 'codex' },
      { terminalId: TAB_ID, wholeTab: true },
      () => {},
      () => {}
    )
    expect(rig.store.getSessionTabId(id)).toBeNull()
    const tabs = session().unifiedTabs?.[WORKTREE_ID] ?? []
    expect(tabs.some((tab) => tab.contentType === 'agent-session' && tab.entityId === id)).toBe(
      false
    )
    expect(project).not.toHaveBeenCalled()
  }
)

// A window-owned switch the window refused before applying: the chat's record names the tab the
// window says it will open the chat in (main's copy of its tabs can trail it).
it("records a refused switch's chat where the owning window opens it", async () => {
  const { runtime } = setupMainOwnedWorkspace()
  vi.spyOn(runtime, 'getAvailableAuthoritativeWindow').mockReturnValue(7 as never)
  const usual = structuredAgentSessionTabId(id)
  vi.spyOn(runtime, 'setSwitchedTabContent').mockImplementation(async (_ws, _request, decide) =>
    decide ? { retargeted: true, tabId: TAB_ID } : { retargeted: false, tabId: `${usual}-2` }
  )
  const publish = vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockResolvedValue()
  await placeSwitchChat(
    { runtime } as never,
    rig.host,
    { workspaceId: WORKTREE_ID, sessionId: id, agent: 'codex' },
    { terminalId: TAB_ID, wholeTab: true, besideTerminalId: TAB_ID },
    () => {},
    () => {}
  )
  expect(rig.store.getSessionTabId(id)).toBe(`${usual}-2`)
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: `${usual}-2`, committed: expect.any(Function) })
  )
})
