import type { VoiceControlErrorKind } from '../../shared/voice-control-types'
import {
  classifyOpenAiFetchError,
  classifyOpenAiHttpStatus
} from './openai-realtime-error-classification'

/** The voice control's one error type: always carries a renderer-actionable kind. */
export class VoiceControlRealtimeError extends Error {
  constructor(
    readonly kind: VoiceControlErrorKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'VoiceControlRealtimeError'
  }

  static fromFetchFailure(error: unknown): VoiceControlRealtimeError {
    const kind = classifyOpenAiFetchError(error)
    const detail = error instanceof Error ? error.message : String(error)
    return new VoiceControlRealtimeError(kind, detail, { cause: error })
  }

  static async fromHttpResponse(response: Response): Promise<VoiceControlRealtimeError> {
    const kind = classifyOpenAiHttpStatus(response.status)
    const body = await response.text().catch(() => '')
    return new VoiceControlRealtimeError(
      kind,
      `openai realtime returned ${response.status}: ${body.slice(0, 300)}`
    )
  }
}
