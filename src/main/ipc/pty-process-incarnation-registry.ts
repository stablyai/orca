const ptyProcessIncarnationById = new Map<string, string>()

export function getPtyProcessIncarnation(ptyId: string): string | null {
  return ptyProcessIncarnationById.get(ptyId) ?? null
}

export { ptyProcessIncarnationById }
