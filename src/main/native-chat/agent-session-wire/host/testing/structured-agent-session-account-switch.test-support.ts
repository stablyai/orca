import { join } from 'node:path'
import { expect } from 'vitest'
import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import type { AgentChildWorkView } from '../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { agentSessionMessagePayload } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { moveChatsAfterClaudeAccountSelection } from '../../../../claude-accounts/selection/claude-account-switch-chat-moves'
import { reportedChildWork } from '../../observations/testing/structured-agent-session-reported-child-work.test-support'
import { REST_TEST_CALLER } from './structured-agent-session-rest-test-rig.test-fixture'
import {
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import {
  type createReceivingCallerFixture,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'

export type AccountSwitchFixture = Awaited<ReturnType<typeof createReceivingCallerFixture>>
type Fixture = AccountSwitchFixture

export const MOVED_MESSAGE =
  "Orca moved this chat to another account. Resume the original unfinished user task with existing commitments and authorization. Check what's completed or still running before repeating actions. Recover needed interrupted work, re-ask only necessary unanswered questions, and continue until done or genuinely blocked."
export const MOVED_NOTE =
  'Orca asked this agent to continue after an account switch. Your own prompt was not re-sent.'

export const accountHome = (f: Fixture, account: 'a' | 'b') =>
  join(f.rig.root, 'claude-profiles', account, 'home')

export const devServer: AgentChildWorkView = {
  id: 'child-dev',
  providerId: 'task-dev',
  kind: 'command',
  description: 'npm run dev',
  state: 'working',
  membership: 'live',
  firstObservedAt: 0,
  observedAt: 0,
  stoppable: true,
  invocation: { invocationId: 'spawn-dev', generation: 1 }
}

type DispatchInput = Parameters<Fixture['rig']['adapter']['dispatch']>[0]

export const textOf = (input: DispatchInput) =>
  input.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

export function dispatchedTexts(f: Fixture): string[] {
  return f.rig.adapter.dispatch.mock.calls.map(([input]) => textOf(input))
}

export async function rows(f: Fixture) {
  return (await readTestHostJournal(f.rig.host, PARENT)).items.map((item) => item.body)
}

export function selectB(f: Fixture, policy: ClaudeAccountSwitchRunningSessions): Promise<void> {
  f.selectB()
  return moveChatsAfterClaudeAccountSelection(() => ({
    claudeAccountSwitchRunningSessions: policy
  }))
}

export async function chatOwingBackgroundTask(f: Fixture): Promise<string> {
  await f.found()
  const id = await f.send('start the dev server')
  await f.turn(id, 'running')
  f.rig.host.publishChildWorkEvidence(PARENT, reportedChildWork([devServer], f.rig.clock.now))
  await f.turn(id, 'completed')
  expect(f.rig.host['clientDelivery'].childWorkOpen(PARENT)).toBe(true)
  expect(f.launches).toEqual([accountHome(f, 'a')])
  return id
}

export async function sendWith(
  f: Fixture,
  text: string,
  extra: {
    userSend?: true
    delivery?: 'queue-if-active'
    from?: AgentJournalMessageItem['from']
  } = {}
): Promise<string> {
  const body = { ...hostTestMessage(text), ...(extra.from ? { from: extra.from } : {}) }
  const fields = {
    body: agentSessionMessagePayload(body),
    ...(extra.delivery ? { delivery: extra.delivery } : {})
  }
  const clientOperationId = hostTestOperationId()
  const sent = await f.rig.host.send(REST_TEST_CALLER, {
    ...fields,
    body,
    ...(extra.userSend ? { userSend: true as const } : {}),
    envelope: {
      sessionId: PARENT,
      clientOperationId,
      expectedRuntimeFence: f.rig.store.requireWritableRecord(PARENT).lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: PARENT,
        fields
      })
    }
  })
  expect(sent.ok).toBe(true)
  return clientOperationId
}
