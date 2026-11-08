// Streaming encoders emit a word only once lookahead frames follow it; sherpa-onnx's own decoders pad 0.66 s before inputFinished.
const STOP_TAIL_PADDING_SECONDS = 0.66

export function createStopTailPadding(sampleRate: number): Float32Array {
  return new Float32Array(Math.round(STOP_TAIL_PADDING_SECONDS * sampleRate))
}
