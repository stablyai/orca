import type { BrowserWindow } from 'electron'

import type {
  ArchiveHookApproval,
  ArchiveHookApprovalRequest
} from '../../../shared/worktree/removal/archive-hook-decision'
import { requestRendererReply } from './renderer-reply-request'

// Reading orca.yaml on an SSH or paired host can take a few seconds; stay under the CLI's call timeout.
const ARCHIVE_HOOK_APPROVAL_TIMEOUT_MS = 20_000

export async function requestArchiveHookApprovalFromRenderer(
  mainWindow: BrowserWindow,
  request: ArchiveHookApprovalRequest
): Promise<ArchiveHookApproval> {
  try {
    const { requestId: _requestId, ...approval } = await requestRendererReply<
      ArchiveHookApproval & { requestId: string }
    >(mainWindow, {
      requestChannel: 'ui:archiveHookApprovalRequest',
      replyChannel: 'ui:archiveHookApprovalReply',
      payload: request,
      timeoutMs: ARCHIVE_HOOK_APPROVAL_TIMEOUT_MS,
      timeoutError: 'archive_hook_approval_timeout'
    })
    return approval
  } catch {
    return { decision: 'undecided' }
  }
}
