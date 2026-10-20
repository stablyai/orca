export type AppleSpeechAssetStatus = 'installed' | 'downloading' | 'supported' | 'unsupported'

export type AppleSpeechEvent =
  | { type: 'status'; status: AppleSpeechAssetStatus; locale?: string; reason?: string }
  | { type: 'progress'; progress: number }
  | { type: 'installed'; locale?: string }
  | { type: 'ready'; locale?: string }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'stopped' }
  | { type: 'error'; error: string; detail?: string }

const ASSET_STATUSES: AppleSpeechAssetStatus[] = [
  'installed',
  'downloading',
  'supported',
  'unsupported'
]

function readField(record: object, key: string): unknown {
  return Reflect.get(record, key)
}

function readString(record: object, key: string): string | undefined {
  const value = readField(record, key)
  return typeof value === 'string' ? value : undefined
}

export function parseAppleSpeechEvent(line: string): AppleSpeechEvent | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const record = parsed
  switch (readString(record, 'type') ?? '') {
    case 'status': {
      const reported = readField(record, 'status')
      const status = ASSET_STATUSES.find((candidate) => candidate === reported)
      return status
        ? {
            type: 'status',
            status,
            locale: readString(record, 'locale'),
            reason: readString(record, 'reason')
          }
        : null
    }
    case 'progress': {
      const progress = readField(record, 'progress')
      return typeof progress === 'number' && Number.isFinite(progress)
        ? { type: 'progress', progress: Math.min(1, Math.max(0, progress)) }
        : null
    }
    case 'installed':
      return { type: 'installed', locale: readString(record, 'locale') }
    case 'ready':
      return { type: 'ready', locale: readString(record, 'locale') }
    case 'partial': {
      const text = readString(record, 'text')
      return text === undefined ? null : { type: 'partial', text }
    }
    case 'final': {
      const text = readString(record, 'text')
      return text === undefined ? null : { type: 'final', text }
    }
    case 'stopped':
      return { type: 'stopped' }
    case 'error':
      return {
        type: 'error',
        error: readString(record, 'error') ?? 'apple_speech_failed',
        detail: readString(record, 'detail')
      }
    default:
      return null
  }
}

/**
 * Splits the helper's newline-delimited JSON across chunk boundaries; call
 * `flush` once stdout ends so a trailing line without its newline still lands.
 */
export function createAppleSpeechEventReader(onEvent: (event: AppleSpeechEvent) => void): {
  push: (chunk: string) => void
  flush: () => void
} {
  let buffer = ''
  const emitLine = (line: string): void => {
    const event = parseAppleSpeechEvent(line)
    if (event) {
      onEvent(event)
    }
  }
  return {
    push(chunk) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        emitLine(line)
      }
    },
    flush() {
      const rest = buffer
      buffer = ''
      emitLine(rest)
    }
  }
}

export function describeAppleSpeechError(event: { error: string; detail?: string }): string {
  switch (event.error) {
    case 'unsupported_macos':
      return 'Apple Speech needs macOS 26 or newer.'
    case 'transcriber_unavailable':
      return 'Apple Speech is unavailable on this Mac.'
    case 'locale_unsupported':
      return `Apple Speech does not support this language${event.detail ? ` (${event.detail})` : ''}.`
    case 'assets_not_installed':
      return 'Apple Speech language files are not installed yet.'
    default:
      return event.detail ? `${event.error}: ${event.detail}` : event.error
  }
}
