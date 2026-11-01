// Expose stable reason codes, including local ungranted and frame refusals. Unknown newer-shell codes floor to unreported so caller switches remain exhaustive.
// Messages are display copy, never a contract, and handler-private text never crosses.
export class NativeVerbError extends Error {
  readonly reason: NativeVerbReason

  constructor(reason: NativeVerbReason, message: string) {
    super(message)
    this.name = 'NativeVerbError'
    this.reason = reason
  }
}

export const NATIVE_VERB_REASONS = [
  'ungranted',
  'native_verb_unknown',
  'native_verb_ungranted',
  'native_verb_params',
  'native_verb_result',
  'native_verb_out_of_scope',
  'native_verb_failed',
  'native_media_handle_unknown',
  'native_media_range',
  'native_media_handle_cap',
  'native_media_too_large',
  'native_media_permission_denied',
  'native_verb_not_a_stream',
  'native_audio_not_capturing',
  'native_pdf_no_viewer',
  'native_pdf_host_outdated',
  'native_verb_not_a_verb',
  'bridge_cap_exceeded',
  'bridge_host_disposed',
  'reply-too-large',
  'unreported'
] as const

export type NativeVerbReason = (typeof NATIVE_VERB_REASONS)[number]
