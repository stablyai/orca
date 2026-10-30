/** An untyped JSON object from the YouTrack REST API, before mapping. */
export type RawRecord = Record<string, unknown>

export function isRawRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function rawRecords(value: unknown): RawRecord[] {
  return Array.isArray(value) ? value.filter(isRawRecord) : []
}

/** A bundle's selectable values: named, not archived, in the project's order. */
export function activeBundleValues(bundle: unknown): RawRecord[] {
  return isRawRecord(bundle)
    ? rawRecords(bundle.values)
        .filter((value) => value.archived !== true && typeof value.name === 'string' && value.name)
        .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0))
    : []
}
