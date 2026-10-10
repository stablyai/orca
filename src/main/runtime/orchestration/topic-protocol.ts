const TOPIC_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const TOPIC_GROUP_PREFIX = '@topic:'

function validateTopicName(value: unknown): string {
  if (typeof value !== 'string' || !TOPIC_PATTERN.test(value)) {
    throw new Error(
      'Invalid topic. Use 1-128 lowercase letters, digits, dots, underscores, slashes, or hyphens.'
    )
  }
  return value
}

export function parseTopicList(value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Topic list must be a JSON array of topic names.')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Topic list must be a JSON array of topic names.')
  }

  const topics: string[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    const topic = validateTopicName(entry)
    if (!seen.has(topic)) {
      seen.add(topic)
      topics.push(topic)
    }
  }
  return topics
}

export function parseTopicGroupAddress(address: string): string | undefined {
  if (!address.toLowerCase().startsWith(TOPIC_GROUP_PREFIX)) {
    return undefined
  }
  return validateTopicName(address.slice(TOPIC_GROUP_PREFIX.length))
}
