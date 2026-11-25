import type { NdjsonRejectedRecord } from '../../../shared/json-stream/main-process-ndjson-framer'
import {
  providerDiagnostic,
  type ProviderDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'

const MB = 2 ** 20

function size(bytes: number): string {
  return bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${bytes} bytes`
}

/** A Codex line over the size limit: a reply fails its request, anything else ends the session. */
export class CodexAppServerFrameSizeError extends Error {
  /** Shown behind the chat failure notice's Details, so the reason isn't lost. */
  readonly providerDiagnostic?: ProviderDiagnostic

  constructor(
    readonly method: string | null,
    readonly observedBytes: number,
    readonly maxBytes: number,
    kind: 'response' | 'notification' | 'message' = 'response'
  ) {
    super(
      `A Codex ${method ? `${method} ` : ''}${kind} was over the ${size(maxBytes)} limit for one message`
    )
    this.name = 'CodexAppServerFrameSizeError'
    this.providerDiagnostic = providerDiagnostic(this.message, 'log')
  }
}

/** A line over the limit with nothing known about what it was. */
export function oversizedLineError(
  rejected: NdjsonRejectedRecord & { kind: 'line-too-long' }
): CodexAppServerFrameSizeError {
  return new CodexAppServerFrameSizeError(
    null,
    rejected.observedBytes,
    rejected.maxLineBytes,
    'message'
  )
}
