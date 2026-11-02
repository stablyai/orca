import type { SqlRow } from '@orca-cloud/cloud-database'
import { ConnectorDeliveryResultSchema } from '@orca-cloud/connector-contract'
import type { ConversationStatus } from './connector-adapter.js'
import type { OwnerActionState } from './owner-controls.js'

function resultOf(latest: SqlRow | undefined) {
  return latest?.state === 'done'
    ? ConnectorDeliveryResultSchema.safeParse(JSON.parse(String(latest.result))).data
    : undefined
}

// The newest delivery never reached the machine.
function unreached(latest: SqlRow | undefined): boolean {
  return latest?.state === 'expired' || resultOf(latest)?.outcome === 'expired'
}

// The owner's answer to the shown prompt: working while it is on its way, else its outcome.
function answerStatus(state: OwnerActionState): ConversationStatus {
  switch (state.kind) {
    case 'on_its_way':
      return { kind: 'working' }
    case 'refused':
      return { kind: 'refused', reason: state.reason }
    case 'unknown':
      return { kind: 'unknown' }
    case 'unreached':
      return { kind: 'offline' }
  }
}

// The one place status precedence lives. `latest` is the conversation's newest start or send,
// `answer` the owner's answer to the shown prompt, `answerHere` whether its card offers buttons.
export function conversationStatus(
  thread: SqlRow,
  latest: SqlRow | undefined,
  answer: OwnerActionState | null,
  answerHere: boolean
): ConversationStatus {
  const result = resultOf(latest)
  // The newest message never arriving outranks whatever the last turn left showing.
  if (unreached(latest)) {
    return { kind: 'offline' }
  }
  if (thread.pending_prompt !== null) {
    return answer ? answerStatus(answer) : { kind: 'needs_answer', answerHere }
  }
  if (thread.turn_state === 'working') {
    return { kind: 'working' }
  }
  if (latest?.state === 'pending' || latest?.state === 'held' || latest?.state === 'leased') {
    return { kind: 'waiting' }
  }
  switch (result?.outcome) {
    case 'refused':
      return { kind: 'refused', reason: result.reason }
    case 'unsupported':
      return { kind: 'unsupported' }
    case 'unknown':
      return { kind: 'unknown' }
  }
  if (thread.turn_state === 'unverifiable') {
    return { kind: 'no_update' }
  }
  if (thread.turn_state === 'ended') {
    return { kind: 'done' }
  }
  return latest ? { kind: 'working' } : { kind: 'waiting' }
}
