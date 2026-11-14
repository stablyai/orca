import { providerFileChangeApprovalDetail } from '../../../native-chat/agent-session-timeline/provider-file-change-approval-detail'
import { MAX_CODEX_DETAIL_BYTES } from '../journal/codex-structured-journal-limits'

export function codexFileChangeApprovalDetail(changes: unknown): string | null {
  return providerFileChangeApprovalDetail(changes, MAX_CODEX_DETAIL_BYTES)
}
