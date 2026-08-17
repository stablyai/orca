// Single-sources the marker logic (pure functions over shared types):
// Claude records an attached image as `[Image: source: /path]` (+ `[Image #N]`
// on the caption turn), and both render and echo reconciliation must
// agree with desktop on how those marker turns are interpreted.
export {
  countImagePromptMarkers,
  imageSourcePathFromText,
  hasImagePromptMarker,
  isImageSourceUserTurn,
  nativeChatUserMessageImageEvidenceCount,
  nativeChatUserMessageMatchText,
  nativeChatUserTextMatchText,
  normalizeImageTranscriptMessages,
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText,
  stripImagePromptMarker,
  stripImagePromptMarkersFromTextBlocks
} from '../../../src/shared/native-chat-image-transcript-markers'
