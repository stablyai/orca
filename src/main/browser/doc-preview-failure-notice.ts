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

// The shell cannot inspect guest HTTP status; push failures so it can replace the rendered error body.
export function publishDocPreviewFailure(failure: DocPreviewFailure): void {
  const sink = failureSink
  // Reads can outlive their window; a destroyed sink must not break the protocol handler.
  if (!sink || sink.isDestroyed?.()) {
    return
  }
  try {
    sink.send(DOC_PREVIEW_LOAD_FAILURE_CHANNEL, failure)
  } catch {
    failureSink = null
  }
}
