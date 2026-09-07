export function parseVisibleSessionIds(
  raw: unknown,
  schemaVersion: number,
  currentSchemaVersion: number
): { ids: string[]; present: boolean; valid: boolean } {
  if (raw === undefined) {
    return { ids: [], present: false, valid: true }
  }
  if (!Array.isArray(raw)) {
    return { ids: [], present: false, valid: schemaVersion !== currentSchemaVersion }
  }
  const ids: string[] = []
  for (const value of raw) {
    if (typeof value === 'string' && value.length > 0) {
      ids.push(value)
    } else if (schemaVersion === currentSchemaVersion) {
      return { ids: [], present: true, valid: false }
    }
  }
  return { ids, present: true, valid: true }
}
