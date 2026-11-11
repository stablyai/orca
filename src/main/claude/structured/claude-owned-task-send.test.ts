import { expect, it } from 'vitest'
import {
  adapterFor,
  claudeFrame,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'
import { PARENT_TASK_STOP } from '../claude-parent-task-frames.test-fixture'
import { createQueuedMessageTestRig } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'

it('delivers an ordinary send after an owned roster/start refresh without inventing root work', async () => {
  const claude = fakeClaude()
  const evidence: AgentChildWorkEvidence[] = []
  const rig = await createQueuedMessageTestRig({ agent: 'claude' })
  const adapter = adapterFor(
    claude,
    {},
    [],
    [],
    undefined,
    undefined,
    (_sessionId, batch) => evidence.push(...batch),
    (outcome) => {
      void rig.host.settleLateDispatch({ ...outcome, sessionId: SESSION })
    }
  )
  let acquired = false
  try {
    rig.dispatch.mockImplementation(async (input) => {
      if (!acquired) {
        await adapter.acquire({
          identity: identityFor(SESSION),
          fence: 1,
          spawnToken: 'spawn-1',
          events: rig.providerEvents()
        })
        acquired = true
      }
      return adapter.dispatch({ ...input, sessionId: SESSION, fence: 1 })
    })
    const first = rig.send('start the work')
    expect(await first.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(first.id))?.dispatchState).toBe('accepted')
    )
    const connection = claude.connections[0]!
    claudeFrame(connection, {
      type: 'assistant',
      uuid: 'root-answer',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Started.' }] }
    })
    claudeFrame(connection, {
      type: 'result',
      subtype: 'success',
      uuid: 'root-result',
      parent_tool_use_id: null,
      duration_ms: 1000
    })
    await rig.host.collaboratorsForTests().runtimeState.flushAllEventSinks()
    expect(rig.host.currentWork(SESSION)!.working()).toBe(false)

    // Recorded CLI roster has no tool alias; the following start enriches that same task.
    const roster = PARENT_TASK_STOP[2]!.frame
    claudeFrame(connection, {
      ...roster,
      tasks: Array.isArray(roster.tasks) ? roster.tasks.slice(1) : []
    })
    claudeFrame(connection, PARENT_TASK_STOP[3]!.frame)
    await rig.host.collaboratorsForTests().runtimeState.flushAllEventSinks()
    const snapshot = await rig.host.journalSnapshot(SESSION)
    const children = snapshot.items.filter(
      (item) =>
        item.body.kind === 'message' &&
        item.body.blocks.some(
          (block) => block.type === 'background-task' && block.taskId === 'shell-child'
        )
    )
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ agentId: 'shell-child', parentAgentId: 'agent-parent' })
    expect(evidence).toContainEqual(
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({
          handle: expect.objectContaining({ id: 'shell-child' }),
          ownerId: 'agent-parent',
          stoppable: true
        })
      })
    )
    const rootAfterChild = rig.host
      .collaboratorsForTests()
      .sessions.get(SESSION)!
      .journal.runningTurn()

    const followup = rig.send('continue normally')
    expect(await followup.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(followup.id))?.handedOverAt).toBeDefined()
    )
    expect(rootAfterChild).toBeNull()
    expect(connection.sent).toHaveLength(2)
    expect(connection.sent[1]).toMatchObject({
      message: {
        content: [{ type: 'text', text: 'continue normally' }]
      }
    })
  } finally {
    await adapter.closeAll()
    await rig.dispose()
    claude.dispose()
  }
})
