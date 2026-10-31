import { afterEach, beforeEach, expect, it } from 'vitest'
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
  TAB_ID
} from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'

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
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

it.each([true, false])(
  'opens a chat with no source to stop right after the tab the client named (named: %s)',
  async (named) => {
    // A pane the client couldn't capture, or History's row: nothing to stop, only a place.
    const { runtime, session } = setupMainOwnedWorkspace({ split: false })
    expect(
      await runtime.applyLayoutCommand({
        type: 'openAgentSessionTab',
        workspace: WORKTREE_ID,
        sessionId: 'later-tab',
        agent: 'codex',
        tabId: 'agent-session:later-tab'
      })
    ).toMatchObject({ ok: true })
    const answer = await executeStructuredSessionSwitch(
      {
        sessionId: id,
        execution: { invocationId: 'uncaptured', ...(named ? { sourceTabId: TAB_ID } : {}) }
      },
      { runtime },
      'chat'
    )
    expect(answer).toEqual({ status: 'completed', sessionId: id })
    const destination = `agent-session:${id}`
    const group = session().tabGroups?.[WORKTREE_ID]?.find((row) =>
      row.tabOrder.includes(destination)
    )
    expect(group?.tabOrder).toEqual(
      named
        ? [TAB_ID, destination, 'agent-session:later-tab']
        : [TAB_ID, 'agent-session:later-tab', destination]
    )
    expect(group?.activeTabId).toBe(destination)
    const published = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const row = published.tabs.find((tab) => tab.id === destination)
    if (named) {
      expect(row).toMatchObject({ after: { tabId: TAB_ID } })
    } else {
      expect(row).not.toHaveProperty('after')
    }
  }
)
