import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  listStructuredProviderSessionOwnership,
  type StructuredProviderSessionOwnership
} from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import { structuredAgentRuntimeRegistration } from './structured-agent-runtime-registrations'

/** Which chat owns each conversation, under the Session History row id its agent's registration
 *  names: the one index both the duplicate-adoption check and Session History ownership read. */
export function listStructuredSessionHistoryOwnership(
  records: readonly AgentSessionRecord[]
): StructuredProviderSessionOwnership[] {
  return listStructuredProviderSessionOwnership(records, (record, link) =>
    structuredAgentRuntimeRegistration(record.provider)?.sessionHistory?.rowSessionId(link)
  )
}
