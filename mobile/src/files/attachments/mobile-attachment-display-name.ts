const AUTO_GENERATED_NAME = /^(?:orca-paste-|orca-media-|[0-9a-f]{8}-[0-9a-f]{4}-)/i

const DEFAULT_MAX_CHARS = 22

/** A short caption for an attachment: the file's own name with the middle trimmed, or null for a name that tells the reader nothing. */
export function shortAttachmentDisplayName(
  path: string | undefined,
  maxChars: number = DEFAULT_MAX_CHARS
): string | null {
  // An inline data: or blob: address has no file name; its tail is image bytes.
  if (!path || /^(?:data|blob):/i.test(path)) {
    return null
  }
  const name = path.split(/[\\/]/).at(-1)?.trim()
  if (!name || AUTO_GENERATED_NAME.test(name)) {
    return null
  }
  if (name.length <= maxChars) {
    return name
  }
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
  const base = name.slice(0, name.length - extension.length)
  const room = Math.max(maxChars - extension.length - 1, 2)
  const tail = Math.min(5, Math.floor(room / 3))
  return `${base.slice(0, room - tail)}…${tail > 0 ? base.slice(-tail) : ''}${extension}`
}
