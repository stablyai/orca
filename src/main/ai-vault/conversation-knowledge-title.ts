function deriveKnowledgeTitle(sourceTitle: string, summary: string): string {
  const normalized = sourceTitle.trim()
  if (isSpecificKnowledgeTitle(normalized)) {
    return normalized
  }
  const sentence = summary
    .trim()
    .split(/(?<=[.!?。！？])\s+/u)[0]
    ?.trim()
  return (sentence || 'Conversation knowledge').slice(0, 120)
}

export function resolveKnowledgeTitle(
  generatedTitle: string | undefined,
  sourceTitle: string,
  summary: string,
  messages: readonly { role: string; text: string }[]
): string {
  if (generatedTitle && isSpecificKnowledgeTitle(generatedTitle)) {
    return generatedTitle.slice(0, 120)
  }
  const userMessage = messages.find((message) => message.role === 'user')?.text.trim()
  const firstLine = userMessage?.split(/\r?\n/u)[0]?.trim()
  if (firstLine && isSpecificKnowledgeTitle(firstLine)) {
    return firstLine.slice(0, 120)
  }
  return deriveKnowledgeTitle(sourceTitle, summary)
}

function isSpecificKnowledgeTitle(value: string): boolean {
  return value.length > 0 && value.length <= 120 && !isGenericKnowledgeTitle(value)
}

function isGenericKnowledgeTitle(value: string): boolean {
  return /^(?:you are an information curator|summarize the conversation|short descriptive title|conversation knowledge)/i.test(
    value.trim()
  )
}
