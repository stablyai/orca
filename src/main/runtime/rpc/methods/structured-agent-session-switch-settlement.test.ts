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
  ['asks the same tab again and takes its answer', true, 3],
  ['asks nothing more once a later close or switch superseded it', false, 2]
])('settles a committed change whose answer was lost: %s', async (_name, current, asked) => {
  const { runtime } = setupMainOwnedWorkspace()
  let applied = false
  const answer = vi
    .spyOn(runtime, 'setSwitchedTabContent')
    .mockImplementation(async (_ws, request, decide) => {
      expect(request.tabId).toBe(TAB_ID)
      if (decide || applied) {
        return { retargeted: true, tabId: TAB_ID }
      }
      applied = true
      throw new TerminalRevealUnconfirmedError('Tab content change unanswered')
    })
  const commit = vi.fn(async () => {})
  await expect(
    runtime.switchTabContent(WORKTREE_ID, chatRequest, commit, () => current)
  ).resolves.toEqual({ retargeted: true, tabId: TAB_ID })
  expect(commit).toHaveBeenCalledExactlyOnceWith(TAB_ID)
  expect(answer).toHaveBeenCalledTimes(asked)
})

// A terminal placed in the chat's tab, its answer lost both times: the committed tab stands, so
// paired clients see it in that tab, and no ordinary tab opens beside it.
it('keeps a lost terminal answer in the committed tab, opening no ordinary tab', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  runtime.registerPty('settling-pty', WORKTREE_ID, null, { tabId: 'terminal-E', leafId: LEAF_B })
  vi.spyOn(runtime, 'setSwitchedTabContent').mockImplementation(async (_ws, _request, decide) => {
    if (decide) {
      return { retargeted: true, tabId: TAB_ID }
    }
    throw new TerminalRevealUnconfirmedError('Tab content change unanswered')
  })
  const ordinary = vi.spyOn(runtime, 'applyLayoutCommand')
  const publish = vi
    .spyOn(runtime, 'publishPtyBackedMobileSessionTerminal')
    .mockImplementation(() => {})
  await runtime.placeSwitchTerminal(WORKTREE_ID, {
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
    commit: async () => {}
  })
  expect(publish).toHaveBeenCalledWith(
    WORKTREE_ID,
    expect.anything(),
    expect.objectContaining({ inTab: TAB_ID })
  )
  expect(ordinary).not.toHaveBeenCalled()
})
