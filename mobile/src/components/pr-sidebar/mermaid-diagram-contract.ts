import {
  MOBILE_WEB_MERMAID_ENGINE_CHUNK_CHARACTERS,
  MOBILE_WEB_MERMAID_FRAME_ENGINE_CHANNEL,
  MOBILE_WEB_MERMAID_FRAME_INIT_CHANNEL,
  MOBILE_WEB_MERMAID_FRAME_MESSAGE_CHANNEL,
  MOBILE_WEB_MERMAID_MAX_ENGINE_CHARACTERS,
  MOBILE_WEB_MERMAID_MAX_SOURCE_CHARACTERS
} from '../../../../src/shared/mobile-web/mermaid-frame-document'

export const MERMAID_DIAGRAM_MESSAGE_CHANNEL = MOBILE_WEB_MERMAID_FRAME_MESSAGE_CHANNEL
export const MERMAID_DIAGRAM_ENGINE_MESSAGE_CHANNEL = MOBILE_WEB_MERMAID_FRAME_ENGINE_CHANNEL
export const MERMAID_DIAGRAM_MAX_SOURCE_CHARACTERS = MOBILE_WEB_MERMAID_MAX_SOURCE_CHARACTERS
export const MERMAID_DIAGRAM_ENGINE_CHUNK_CHARACTERS = MOBILE_WEB_MERMAID_ENGINE_CHUNK_CHARACTERS

export function createMermaidDiagramInitializationMessage(
  source: string,
  engine: string,
  token: string
) {
  if (
    source.length > MERMAID_DIAGRAM_MAX_SOURCE_CHARACTERS ||
    engine.length < 1 ||
    engine.length > MOBILE_WEB_MERMAID_MAX_ENGINE_CHARACTERS
  ) {
    return null
  }
  return {
    channel: MOBILE_WEB_MERMAID_FRAME_INIT_CHANNEL,
    token,
    source,
    engineLength: engine.length,
    engineChunkCount: Math.ceil(engine.length / MERMAID_DIAGRAM_ENGINE_CHUNK_CHARACTERS)
  }
}

export function createMermaidDiagramEngineMessages(engine: string, token: string) {
  const chunkCount = Math.ceil(engine.length / MERMAID_DIAGRAM_ENGINE_CHUNK_CHARACTERS)
  return Array.from({ length: chunkCount }, (_, chunkIndex) => ({
    channel: MERMAID_DIAGRAM_ENGINE_MESSAGE_CHANNEL,
    token,
    chunkIndex,
    chunkCount,
    chunk: engine.slice(
      chunkIndex * MERMAID_DIAGRAM_ENGINE_CHUNK_CHARACTERS,
      (chunkIndex + 1) * MERMAID_DIAGRAM_ENGINE_CHUNK_CHARACTERS
    )
  }))
}

export function parseMermaidDiagramMessage(
  value: unknown,
  expectedToken = ''
):
  | { type: 'ready' }
  | { type: 'assembled' }
  | { type: 'rendered'; height: number }
  | { type: 'error' }
  | null {
  try {
    const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const message = parsed as Record<string, unknown>
    if (message.channel !== MERMAID_DIAGRAM_MESSAGE_CHANNEL || message.token !== expectedToken) {
      return null
    }
    if (message.type === 'error') {
      return { type: 'error' }
    }
    if (message.type === 'ready' || message.type === 'assembled') {
      return { type: message.type }
    }
    if (
      message.type === 'rendered' &&
      typeof message.height === 'number' &&
      Number.isFinite(message.height) &&
      message.height > 0 &&
      message.height <= 10000
    ) {
      return { type: 'rendered', height: Math.ceil(message.height) }
    }
    return null
  } catch {
    return null
  }
}
