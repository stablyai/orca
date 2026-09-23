export const COLLABORATION_MESSAGE_PAYLOAD_VERSION = 1 as const

export type CollaborationMessagePayload = {
  version: typeof COLLABORATION_MESSAGE_PAYLOAD_VERSION
  topic: string
  semanticType: string
  producerTaskId: string
}

export function encodeCollaborationMessagePayload(payload: CollaborationMessagePayload): string {
  return JSON.stringify(payload)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCollaborationMessagePayload(json: string): CollaborationMessagePayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  if (parsed.version !== COLLABORATION_MESSAGE_PAYLOAD_VERSION) {
    return null
  }
  if (
    typeof parsed.topic !== 'string' ||
    typeof parsed.semanticType !== 'string' ||
    typeof parsed.producerTaskId !== 'string'
  ) {
    return null
  }
  return {
    version: COLLABORATION_MESSAGE_PAYLOAD_VERSION,
    topic: parsed.topic,
    semanticType: parsed.semanticType,
    producerTaskId: parsed.producerTaskId
  }
}
