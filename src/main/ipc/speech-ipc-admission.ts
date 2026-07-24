import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export const MAX_SPEECH_AUDIO_CHUNK_BYTES = 1024 * 1024
export const MAX_SPEECH_HOTWORDS = 256
export const MAX_SPEECH_HOTWORD_BYTES = 4 * 1024
export const MAX_SPEECH_HOTWORDS_TOTAL_BYTES = 256 * 1024
export const MAX_SPEECH_SESSION_ID_BYTES = 1024
export const MAX_SPEECH_MODEL_ID_BYTES = 1024
export const MAX_SPEECH_OPENAI_API_KEY_BYTES = 64 * 1024
export const MAX_PENDING_DESKTOP_DICTATION_STARTS = 16
export const MAX_ACTIVE_DESKTOP_DICTATION_LISTENERS = 16

const MIN_SPEECH_SAMPLE_RATE = 8_000
const MAX_SPEECH_SAMPLE_RATE = 384_000
const HOTWORD_LINE_SUFFIX = ' :2.0\n'

export type DesktopDictationListener = { release: () => void }

function requireBoundedString(
  value: unknown,
  name: string,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {}
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    measureUtf8ByteLength(value, { stopAfterBytes: maxBytes }).exceededLimit
  ) {
    throw new Error(`Invalid ${name}`)
  }
  return value
}

export function validateSpeechSessionId(value: unknown): string {
  return requireBoundedString(
    value === undefined ? 'desktop' : value,
    'speech session id',
    MAX_SPEECH_SESSION_ID_BYTES
  )
}

export function validateSpeechModelId(value: unknown): string {
  return requireBoundedString(value, 'speech model id', MAX_SPEECH_MODEL_ID_BYTES)
}

export function validateOpenAiSpeechApiKey(value: unknown): string {
  return requireBoundedString(value, 'OpenAI speech API key', MAX_SPEECH_OPENAI_API_KEY_BYTES)
}

export function buildSpeechHotwordsContent(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > MAX_SPEECH_HOTWORDS) {
    throw new Error('Invalid speech hotwords')
  }
  const lines: string[] = []
  let retainedBytes = 0
  for (const hotword of value) {
    const text = requireBoundedString(hotword, 'speech hotword', MAX_SPEECH_HOTWORD_BYTES, {
      allowEmpty: true
    })
    const lineBytes = measureUtf8ByteLength(text).byteLength + HOTWORD_LINE_SUFFIX.length
    if (lineBytes > MAX_SPEECH_HOTWORDS_TOTAL_BYTES - retainedBytes) {
      throw new Error('Speech hotwords are too large')
    }
    retainedBytes += lineBytes
    lines.push(`${text}${HOTWORD_LINE_SUFFIX}`)
  }
  return lines.length > 0 ? lines.join('') : undefined
}

export function decodeSpeechAudioChunk(
  value: unknown,
  sampleRate: unknown
): { samples: Float32Array; sampleRate: number } {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > MAX_SPEECH_AUDIO_CHUNK_BYTES ||
    value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new Error('Invalid speech audio chunk')
  }
  if (
    typeof sampleRate !== 'number' ||
    !Number.isFinite(sampleRate) ||
    sampleRate < MIN_SPEECH_SAMPLE_RATE ||
    sampleRate > MAX_SPEECH_SAMPLE_RATE
  ) {
    throw new Error('Invalid speech sample rate')
  }
  // Why: worker transfer moves the whole backing buffer; own only the admitted view.
  const ownedBytes = new Uint8Array(value.byteLength)
  ownedBytes.set(value)
  return { samples: new Float32Array(ownedBytes.buffer), sampleRate }
}

export class SpeechIpcAdmission {
  private readonly pendingStarts = new Set<string>()
  private readonly activeListeners = new Map<string, DesktopDictationListener>()

  claimStart(owner: string): void {
    if (
      this.pendingStarts.has(owner) ||
      this.pendingStarts.size >= MAX_PENDING_DESKTOP_DICTATION_STARTS
    ) {
      throw new Error('Too many pending speech dictation starts')
    }
    this.pendingStarts.add(owner)
  }

  releaseStart(owner: string): void {
    this.pendingStarts.delete(owner)
  }

  commitListener(owner: string, listener: DesktopDictationListener): void {
    const previous = this.activeListeners.get(owner)
    if (!previous && this.activeListeners.size >= MAX_ACTIVE_DESKTOP_DICTATION_LISTENERS) {
      this.activeListeners.values().next().value?.release()
    }
    this.activeListeners.set(owner, listener)
    previous?.release()
  }

  deleteListenerIfCurrent(owner: string, listener: DesktopDictationListener): void {
    if (this.activeListeners.get(owner) === listener) {
      this.activeListeners.delete(owner)
    }
  }

  releaseListener(owner: string): void {
    this.activeListeners.get(owner)?.release()
  }

  reset(): void {
    this.pendingStarts.clear()
    for (const listener of Array.from(this.activeListeners.values())) {
      listener.release()
    }
    this.activeListeners.clear()
  }

  get pendingStartCount(): number {
    return this.pendingStarts.size
  }

  get activeListenerCount(): number {
    return this.activeListeners.size
  }
}
