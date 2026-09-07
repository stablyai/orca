/* oxlint-disable typescript-eslint/no-explicit-any -- sherpa-onnx native addon has no type definitions */

export function clearSttWorkerUtterance(args: {
  sherpa: any
  recognizer: any
  stream: any
  isStreaming: boolean
  resetOfflineSessionState: () => void
}): any {
  const { sherpa, recognizer, isStreaming, resetOfflineSessionState } = args
  let { stream } = args
  if (!recognizer || !stream) {
    return stream
  }
  try {
    if (isStreaming) {
      sherpa.reset(recognizer, stream)
    } else {
      resetOfflineSessionState()
    }
  } catch {
    if (isStreaming && sherpa && recognizer) {
      try {
        stream = sherpa.createOnlineStream(recognizer)
      } catch {}
    }
  }
  return stream
}
