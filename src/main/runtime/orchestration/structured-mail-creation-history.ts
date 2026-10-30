import {
  ordinaryMailCreationId,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import type { Interest, SourceIdentity } from './structured-mail-source-discovery'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  mailMemberKey,
  originalMailHistory,
  type MailCreationHistory
} from './structured-mail-original-history'
export type { MailCreationHistory } from './structured-mail-original-history'
export function observeMailCreationHistory(
  host: StructuredAgentSessionHost,
  listener: (members: ReadonlySet<string>) => void
): () => void {
  return originalMailHistory(host).observe(listener)
}
export function readMailCreationHistory(
  host: StructuredAgentSessionHost,
  _sessionId: string
): MailCreationHistory {
  return originalMailHistory(host).read()
}
export function readSourceCreation(
  host: StructuredMailboxPointerHost,
  interest: Interest,
  source: SourceIdentity
): 'accepted' | 'absent' | 'unknown' {
  const canonical =
    host.selectCreation?.(source)?.state ??
    host.readCreation(ordinaryMailCreationId(source), interest.target.sessionId)
  if (canonical === 'accepted') {
    return 'accepted'
  }
  const history = host.readHistory(interest.target.sessionId)
  if (history.members.has(mailMemberKey(source.run_id, source.id))) {
    return 'accepted'
  }
  return canonical
}
