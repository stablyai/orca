function validLeafUuid(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    return null
  }
  const hasControlCharacter = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
  return value === value.trim() && !hasControlCharacter ? value : null
}

export function readClaudeTranscriptEntryUuid(value: Record<string, unknown>): string | null {
  return value.isSidechain === true ||
    value.parent_tool_use_id != null ||
    (value.type !== 'user' && value.type !== 'assistant')
    ? null
    : validLeafUuid(value.uuid)
}
