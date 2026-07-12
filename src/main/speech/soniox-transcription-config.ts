const SONIOX_MODEL_BY_ID: Record<string, string> = {
  'soniox-stt-rt-v5': 'stt-rt-v5'
}

export function createSonioxStartRequest(modelId: string, apiKey: string) {
  const model = SONIOX_MODEL_BY_ID[modelId]
  if (!model) {
    throw new Error(`Unknown Soniox transcription model: ${modelId}`)
  }
  return {
    api_key: apiKey,
    model,
    audio_format: 'pcm_s16le',
    sample_rate: 16000,
    num_channels: 1,
    enable_endpoint_detection: true
  }
}
