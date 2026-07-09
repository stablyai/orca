import { posix } from 'node:path'
import type { IFilesystemProvider } from '../providers/types'
import { isMarkdownDocumentName } from '../ipc/markdown-documents'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { isContainedRelativePath, resolveWikiDir, shapeWikiOverview } from './wiki-repository'

function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}

export async function readWikiOverviewSsh(
  provider: IFilesystemProvider,
  worktreePath: string,
  repoName: string
): Promise<{ hasWiki: boolean; rootRelativePath: string | null; notes: string[] }> {
  const wikiDir = resolveWikiDir(worktreePath)
  let relPaths: string[]
  try {
    relPaths = await provider.listFiles(wikiDir)
  } catch {
    return { hasWiki: false, rootRelativePath: null, notes: [] }
  }
  const notes = relPaths
    .map(toPosix)
    .filter((p) => isMarkdownDocumentName(p) && isContainedRelativePath(p))
    .sort((a, b) => a.localeCompare(b))
  return shapeWikiOverview(notes, repoName)
}

export async function readWikiNoteSsh(
  provider: IFilesystemProvider,
  worktreePath: string,
  relativePath: string
): Promise<{ relativePath: string; content: string } | null> {
  if (!isContainedRelativePath(relativePath)) {
    return null
  }
  const normalized = toPosix(relativePath)
  if (!isMarkdownDocumentName(normalized)) {
    return null
  }
  const wikiDir = resolveWikiDir(worktreePath)
  const abs = posix.join(toPosix(wikiDir), normalized)
  try {
    // Why: reject symlink escapes — the resolved real path must stay inside .wiki/.
    const [realWikiDir, realAbs] = await Promise.all([
      provider.realpath(wikiDir),
      provider.realpath(abs)
    ])
    if (!isPathInsideOrEqual(toPosix(realWikiDir), toPosix(realAbs))) {
      return null
    }
    const fileStat = await provider.stat(abs)
    if (fileStat.type !== 'file') {
      return null
    }
    const result = await provider.readFile(abs)
    if (result.isBinary) {
      return null
    }
    return { relativePath: normalized, content: result.content }
  } catch {
    return null
  }
}
