// Single-sources the marker logic (pure functions over shared types):
// Claude records an attached image as `[Image: source: /path]` (+ `[Image #N]`
// on the caption turn), and both render and echo reconciliation must
// agree with desktop on how those marker turns are interpreted.
export {
  imageSourcePathFromText,
  hasImagePromptMarker,
  isImageSourceUserTurn,
  normalizeImageTranscriptMessages,
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText,
  stripImagePromptMarker
} from '../../../src/shared/native-chat-image-transcript-markers'
