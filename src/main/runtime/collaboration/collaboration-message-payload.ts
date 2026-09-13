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

export function parseCollaborationMessagePayload(json: string): CollaborationMessagePayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== COLLABORATION_MESSAGE_PAYLOAD_VERSION) {
    return null
  }
  if (
    typeof record.topic !== 'string' ||
    typeof record.semanticType !== 'string' ||
    typeof record.producerTaskId !== 'string'
  ) {
    return null
  }
  return {
    version: COLLABORATION_MESSAGE_PAYLOAD_VERSION,
    topic: record.topic,
    semanticType: record.semanticType,
    producerTaskId: record.producerTaskId
  }
}
