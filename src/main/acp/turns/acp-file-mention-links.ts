import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import type { ContentBlock } from '../generated/acp-protocol.generated'

// The spellings formatNativeChatFileReference writes: @"…" (with \" escapes), @'…', or a bare @path.
const FILE_MENTION = /(?:^|\s)@(?:"((?:\\"|[^"])*)"|'([^']*)'|([^\s"'`]+))/g
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/

function mentionedPaths(texts: readonly string[]): Set<string> {
  const paths = new Set<string>()
  for (const text of texts) {
    for (const [, doubleQuoted, singleQuoted, bare] of text.matchAll(FILE_MENTION)) {
      const path =
        doubleQuoted?.replace(/\\"/g, '"') ?? singleQuoted ?? bare.replace(TRAILING_PUNCTUATION, '')
      if (path) {
        paths.add(path)
      }
    }
  }
  return paths
}

/** One link per `@path` naming a file inside `root`; symlinks and `..` cannot leave it. */
export async function acpFileMentionLinks(
  texts: readonly string[],
  root: string
): Promise<ContentBlock[]> {
  const paths = mentionedPaths(texts)
  const realRoot = paths.size > 0 ? await realpath(root).catch(() => null) : null
  if (!realRoot) {
    return []
  }
  const links = new Map<string, ContentBlock>()
  for (const path of paths) {
    const target = await realpath(resolve(realRoot, path)).catch(() => null)
    if (
      target &&
      !links.has(target) &&
      isPathInsideOrEqual(realRoot, target) &&
      (await stat(target).then(
        (info) => info.isFile(),
        () => false
      ))
    ) {
      links.set(target, { type: 'resource_link', uri: pathToFileURL(target).href, name: path })
    }
  }
  return [...links.values()]
}
