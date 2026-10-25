// Live dictation sends to its originating PTY without Return; buffered dictation appends to the command field.

export type LiveDictationRoute =
  | { readonly kind: 'live-insert'; readonly text: string }
  | { readonly kind: 'buffered-append'; readonly text: string }

export function routeDictationTranscript(
  transcript: string,
  liveInputActive: boolean
): LiveDictationRoute {
  return liveInputActive
    ? { kind: 'live-insert', text: transcript }
    : { kind: 'buffered-append', text: transcript }
}

export function appendBufferedDictation(current: string, transcript: string): string {
  if (!current.trim()) {
    return transcript
  }
  return `${current.trimEnd()} ${transcript}`
}
