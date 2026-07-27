import { constants, type Dirent } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { SkillFreshnessScanIssueReason } from '../../shared/skill-freshness'

const MAXIMUM_PLUGIN_MANIFEST_BYTES = 256 * 1024
const PLUGIN_MANIFEST_DIRECTORIES = ['.codex-plugin', '.claude-plugin', '.cursor-plugin'] as const
const MANIFEST_OPEN_FLAGS =
  constants.O_RDONLY |
  (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW)

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}

export function isWithinRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return !isAbsolute(relativePath) && relativePath.split(sep)[0] !== '..'
}

function resolveManifestSkillPath(directory: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('./')) {
    return null
  }
  const relativePath = value.slice(2)
  if (!relativePath || relativePath.split(/[\\/]/).includes('..')) {
    return null
  }
  return join(directory, relativePath)
}

export async function declaredPluginSkillRoots(
  directory: string,
  entries: readonly Dirent[],
  resolvedRoot: string,
  recordIssue: (path: string, reason: SkillFreshnessScanIssueReason, code?: string | null) => void
): Promise<string[] | null> {
  for (const manifestDirectory of PLUGIN_MANIFEST_DIRECTORIES) {
    if (!entries.some((entry) => entry.name === manifestDirectory)) {
      continue
    }
    const manifestPath = join(directory, manifestDirectory, 'plugin.json')
    let resolvedManifestPath: string
    try {
      resolvedManifestPath = await realpath(manifestPath)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        continue
      }
      recordIssue(manifestPath, 'io-error', code)
      return null
    }
    if (!isWithinRoot(resolvedRoot, resolvedManifestPath)) {
      recordIssue(manifestPath, 'outside-root')
      return null
    }
    let manifestFile: Awaited<ReturnType<typeof open>>
    try {
      manifestFile = await open(resolvedManifestPath, MANIFEST_OPEN_FLAGS)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        continue
      }
      recordIssue(manifestPath, 'io-error', code)
      return null
    }
    try {
      const manifestStat = await manifestFile.stat()
      if (!manifestStat.isFile()) {
        continue
      }
      if (manifestStat.size > MAXIMUM_PLUGIN_MANIFEST_BYTES) {
        recordIssue(manifestPath, 'manifest-limit')
        return null
      }
      const content = Buffer.alloc(MAXIMUM_PLUGIN_MANIFEST_BYTES + 1)
      let contentLength = 0
      while (contentLength < content.length) {
        const { bytesRead } = await manifestFile.read(
          content,
          contentLength,
          content.length - contentLength,
          contentLength
        )
        if (bytesRead === 0) {
          break
        }
        contentLength += bytesRead
      }
      if (contentLength > MAXIMUM_PLUGIN_MANIFEST_BYTES) {
        recordIssue(manifestPath, 'manifest-limit')
        return null
      }
      const parsed: unknown = JSON.parse(content.toString('utf8', 0, contentLength))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null
      }
      const skills = (parsed as Record<string, unknown>).skills
      const values = Array.isArray(skills) ? skills : [skills]
      const roots = values
        .map((value) => resolveManifestSkillPath(directory, value))
        .filter((value): value is string => value !== null)
      return roots.length > 0 ? [...new Set(roots)] : [join(directory, 'skills')]
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        recordIssue(manifestPath, 'io-error', errorCode(error))
      }
      return null
    } finally {
      await manifestFile.close().catch(() => undefined)
    }
  }
  return null
}
