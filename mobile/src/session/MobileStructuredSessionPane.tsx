// Wires one structured agent session entry into the chat view. Kept out of the
// session route so the route threads one object instead of eighteen props.

import { MobileStructuredAgentSessionView } from './MobileStructuredAgentSessionView'
import type { useMobileStructuredSessionEntry } from './use-mobile-structured-session-entry'

type StructuredSessionEntry = ReturnType<typeof useMobileStructuredSessionEntry>

export function MobileStructuredSessionPane({
  entry,
  onOpenFile
}: {
  entry: StructuredSessionEntry
  onOpenFile: (path: string, line?: number) => void
}) {
  const { session, writes, attachments, sessionOptions } = entry
  return (
    <MobileStructuredAgentSessionView
      items={session.items}
      status={session.status}
      error={session.error}
      hasOlder={session.hasOlder}
      loadingOlder={session.loadingOlder}
      onLoadOlder={session.loadOlder}
      onOpenFile={onOpenFile}
      outbox={writes.outbox}
      writeError={writes.error}
      onSend={async (text, restored) => {
        const accepted = await writes.send(text, [...restored, ...attachments.attachments])
        if (accepted) {
          attachments.clear()
        }
        return accepted
      }}
      onTakeQueuedForEdit={writes.takeQueuedForEdit}
      onRetry={writes.retry}
      onRespondToPrompt={writes.respondToPrompt}
      sessionOptions={sessionOptions}
      attachments={attachments.attachments}
      isAttaching={attachments.attaching}
      onAttachImage={() => void attachments.attach('library')}
      onRemoveAttachment={attachments.remove}
      onCancel={writes.cancel}
    />
  )
}
