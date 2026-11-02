// Live dictation sends to its originating PTY without Return; buffered dictation lands in the command field.

export type LiveDictationRoute =
  | { readonly kind: 'live-insert'; readonly text: string }
  | { readonly kind: 'buffered-insert'; readonly text: string }

export function routeDictationTranscript(
  transcript: string,
  liveInputActive: boolean
): LiveDictationRoute {
  return liveInputActive
    ? { kind: 'live-insert', text: transcript }
    : { kind: 'buffered-insert', text: transcript }
}
