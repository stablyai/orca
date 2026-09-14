import {
  DOC_PREVIEW_LOAD_FAILURE_CHANNEL,
  type DocPreviewFailure
} from '../../shared/doc-preview-scheme'

type DocPreviewFailureSink = {
  send: (channel: string, payload: DocPreviewFailure) => void
  isDestroyed?: () => boolean
}

let failureSink: DocPreviewFailureSink | null = null

export function setDocPreviewFailureSink(sink: DocPreviewFailureSink | null): void {
  failureSink = sink
}

/**
 * The preview shell cannot read the guest's HTTP status, and a 4xx body renders as
 * if it were the document. Pushing the reason lets the shell replace that with a
 * localized notice for the failure the user actually hit.
 */
export function publishDocPreviewFailure(failure: DocPreviewFailure): void {
  const sink = failureSink
  // Why: a read can outlive the window that asked for it, and sending into torn-down
  // WebContents throws — an unreadable asset must not take the protocol handler with it.
  if (!sink || sink.isDestroyed?.()) {
    return
  }
  try {
    sink.send(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, failure)
  } catch {
    failureSink = null
  }
}
