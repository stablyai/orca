import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeChatTextAttachmentParts } from '../../../shared/native-chat-text-attachment-references'
import type { ContentBlock } from '../generated/acp-protocol.generated'

const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/

/** The real path of a file inside `realRoot`; symlinks and `..` cannot leave it. */
async function fileInside(realRoot: string, path: string): Promise<string | null> {
  const target = await realpath(resolve(realRoot, path)).catch(() => null)
  // Byte-exact: Unicode or case folding would admit a sibling folder on Linux.
  const inside = target ? relative(realRoot, target) : ''
  if (
    !target ||
    !inside ||
    inside === '..' ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    return null
  }
  return (await stat(target).then(
    (info) => info.isFile(),
    () => false
  ))
    ? target
    : null
}

/** One link per `@path` naming a file inside `root`. */
export async function acpFileMentionLinks(
  texts: readonly string[],
  root: string
): Promise<ContentBlock[]> {
  const paths = new Set(
    texts.flatMap((text) =>
      nativeChatTextAttachmentParts(text, true, () => true).flatMap((part) =>
        part.path ? [part.path] : []
      )
    )
  )
  const realRoot = paths.size > 0 ? await realpath(root).catch(() => null) : null
  if (!realRoot) {
    return []
  }
  const links = new Map<string, ContentBlock>()
  for (const path of paths) {
    // Punctuation after a mention belongs to the sentence unless the name itself exists.
    const trimmed = path.replace(TRAILING_PUNCTUATION, '')
    const literal = await fileInside(realRoot, path)
    const name = literal ? path : trimmed
    const target =
      literal ?? (trimmed && trimmed !== path ? await fileInside(realRoot, trimmed) : null)
    if (target && !links.has(target)) {
      links.set(target, { type: 'resource_link', uri: pathToFileURL(target).href, name })
    }
  }
  return [...links.values()]
}
