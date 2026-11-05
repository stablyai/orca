// IPC callers may only name a source kind; paths and other fields are rejected so the renderer cannot pick files itself.
export function validateImportSource<K extends string>(
  source: unknown,
  kinds: readonly K[]
): { kind: K } | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null
  }
  const entries = Object.entries(source)
  if (entries.length !== 1 || entries[0]?.[0] !== 'kind') {
    return null
  }
  const kind = kinds.find((candidate) => candidate === entries[0]?.[1])
  return kind === undefined ? null : { kind }
}
