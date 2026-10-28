import type { OrchestrationDb } from '../../../../orchestration/db'
import type { MessageRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { remoteRunHomeUnreachable } from '../routing'
import { sendRemoteMessage } from './send-remote'

/** Reply to mirrored remote-Run mail only at its home, through this pane's own Dispatch link. */
export async function replyToRemoteRunHome(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  original: MessageRow
  params: { body: string; from?: string; run?: string }
  signal?: AbortSignal
}): Promise<unknown> {
  const { runtime, db, original, params } = args
  const from = params.from ?? original.to_handle
  const paneKey = runtime.getTerminalPaneKey(from)
  const attachment = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
  if (
    !paneKey ||
    !attachment ||
    attachment.home_run_id !== original.run_id ||
    // Another worker in the same Run cannot answer this Dispatch's mail.
    original.to_handle !== `dispatch:${attachment.dispatch_id}`
  ) {
    throw remoteRunHomeUnreachable(db, original.run_id)
  }
  const subject = `Re: ${original.subject}`
  const sent = await sendRemoteMessage({
    params: {
      from,
      subject,
      body: params.body,
      threadId: original.thread_id ?? original.id,
      ...(params.run ? { run: params.run } : {})
    },
    runtime,
    db,
    from,
    senderPaneKey: paneKey,
    remoteAttachment: attachment,
    processIncarnation: runtime.getTerminalProcessIncarnation(from) ?? undefined,
    signal: args.signal
  })
  db.markAsRead([original.id])
  // Preserve message: every shipped CLI reads its reply id there.
  return { message: { id: sent.relay.messageId, subject }, ...sent }
}
