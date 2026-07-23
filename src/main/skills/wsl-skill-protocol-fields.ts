export type WslSkillProtocolFieldCursor = { offset: number }

export function readWslSkillProtocolField(
  output: string,
  cursor: WslSkillProtocolFieldCursor,
  incompleteMessage: string
): string {
  if (cursor.offset >= output.length) {
    throw new Error(incompleteMessage)
  }
  const end = output.indexOf('\0', cursor.offset)
  if (end === -1) {
    const value = output.slice(cursor.offset)
    cursor.offset = output.length
    return value
  }
  const value = output.slice(cursor.offset, end)
  cursor.offset = end + 1
  return value
}
