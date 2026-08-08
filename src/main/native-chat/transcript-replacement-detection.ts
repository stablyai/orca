import { transcriptFileVersionChanged, type TranscriptFileVersion } from './transcript-file-version'

export function detectTranscriptReplacement(
  current: TranscriptFileVersion,
  watched: TranscriptFileVersion | null,
  offset: number,
  currentBoundary: string,
  watchedBoundary: string
): { identityChanged: boolean; contentReplaced: boolean } {
  const identityChanged = watched !== null && current.identity !== watched.identity
  const sameSizeVersionChanged =
    watched !== null &&
    current.identity === watched.identity &&
    current.size === watched.size &&
    transcriptFileVersionChanged(current, watched)
  return {
    identityChanged,
    contentReplaced:
      identityChanged ||
      sameSizeVersionChanged ||
      current.size < offset ||
      (offset > 0 && watchedBoundary !== currentBoundary)
  }
}
