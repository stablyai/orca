import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, posix, relative, sep, win32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { FileWithMtime } from './session-scanner-types'

export { CURSOR_SIDECAR_MAX_BYTES } from '../../shared/cursor-sidecar-scan'
export const CURSOR_BUCKET_PATTERN = /^[0-9a-f]{32}$/

export function resolveCursorLocalRoots(
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env
): { chatsDir: string; projectsDir: string } {
  const configRoot =
    nonblank(env.CURSOR_CONFIG_DIR) ??
    (nonblank(env.XDG_CONFIG_HOME) ? join(nonblank(env.XDG_CONFIG_HOME)!, 'cursor') : null) ??
    join(homeDir, '.cursor')
  const dataRoot = nonblank(env.CURSOR_DATA_DIR) ?? join(homeDir, '.cursor')
  return {
    chatsDir: join(configRoot, 'chats'),
    projectsDir: join(dataRoot, 'projects')
  }
}

export function cursorBucketForCwd(cwd: string, platform: NodeJS.Platform): string {
  const resolved = resolveCursorTargetPath(cwd, platform)
  return createHash('md5').update(resolved).digest('hex')
}

export function resolveCursorTargetPath(cwd: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.resolve(cwd) : posix.resolve(cwd)
}

export function isAbsoluteCursorTargetPath(cwd: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(cwd) : posix.isAbsolute(cwd)
}

export function cursorWindowsPathVariants(pathValue: string): string[] {
  const resolved = win32.resolve(pathValue)
  const drive = resolved.match(/^([A-Za-z]):/)
  if (!drive) {
    return [resolved]
  }
  return [
    ...new Set([
      resolved,
      `${drive[1].toUpperCase()}${resolved.slice(1)}`,
      `${drive[1].toLowerCase()}${resolved.slice(1)}`
    ])
  ]
}

export function cursorScopeCwdCandidates(args: {
  scopePath: string
  platform: NodeJS.Platform
  storageContextKey: string
}): string[] {
  const trimmed = args.scopePath.trim()
  if (!trimmed) {
    return []
  }
  if (args.storageContextKey.startsWith('wsl:')) {
    const parsed = parseWslUncPath(trimmed)
    const distro = args.storageContextKey.slice('wsl:'.length)
    if (!parsed || parsed.distro.toLowerCase() !== distro.toLowerCase()) {
      return []
    }
    return [posix.resolve(parsed.linuxPath)]
  }
  if (
    args.storageContextKey === 'native' &&
    args.platform === 'win32' &&
    parseWslUncPath(trimmed)
  ) {
    return []
  }
  if (!isAbsoluteCursorTargetPath(trimmed, args.platform)) {
    return []
  }
  return args.platform === 'win32' ? cursorWindowsPathVariants(trimmed) : [posix.resolve(trimmed)]
}

export function cursorLegacySlug(cwd: string): string {
  return cwd
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function isSafeCursorSessionBasename(name: string): boolean {
  return Boolean(
    name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  )
}

export function isCursorSidecarDirectory(name: string, depth: number): boolean {
  if (depth === 0) {
    return CURSOR_BUCKET_PATTERN.test(name)
  }
  return depth === 1 && isSafeCursorSessionBasename(name)
}

export function isCursorSidecarPath(chatsRoot: string, filePath: string): boolean {
  const segments = relative(chatsRoot, filePath).split(sep)
  return (
    segments.length === 3 &&
    CURSOR_BUCKET_PATTERN.test(segments[0]) &&
    isSafeCursorSessionBasename(segments[1]) &&
    segments[2] === 'meta.json'
  )
}

export function cursorSidecarSessionId(filePath: string, platform: NodeJS.Platform): string | null {
  const pathOps = platform === 'win32' ? win32 : posix
  const sessionId = pathOps.basename(pathOps.dirname(filePath))
  return isSafeCursorSessionBasename(sessionId) ? sessionId : null
}

export function cursorSidecarBucket(filePath: string, platform: NodeJS.Platform): string | null {
  const pathOps = platform === 'win32' ? win32 : posix
  const bucket = pathOps.basename(pathOps.dirname(pathOps.dirname(filePath)))
  return CURSOR_BUCKET_PATTERN.test(bucket) ? bucket : null
}

export function cursorStorageContextKey(rootDir: string): string {
  const parsed = parseWslUncPath(rootDir)
  return parsed ? `wsl:${parsed.distro}` : 'native'
}

export function cursorContextPathForHash(
  pathValue: string,
  storageContextKey: string,
  platform: NodeJS.Platform
): string | null {
  const candidates = cursorScopeCwdCandidates({ scopePath: pathValue, storageContextKey, platform })
  return candidates[0] ?? null
}

export function cursorSessionStorePath(metaPath: string): string {
  return join(metaPath, '..', 'store.db')
}

export function cursorSessionActivityMtimeMs(file: FileWithMtime): number {
  return Math.max(file.mtimeMs, file.cursorStoreMtimeMs ?? 0)
}

function nonblank(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed || null
}
