import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { isRuntimePathAbsolute, isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { hasUnsafeProviderSessionIdChars } from '../../shared/agent-session-resume'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { ReasonixSessionLayout } from '../../shared/reasonix-session-paths'

function canonicalRoot(root: string, platform: RemoteHostPlatform): string | null {
  if (!isRuntimePathAbsolute(root) || root.length > 4096 || hasUnsafeProviderSessionIdChars(root)) {
    return null
  }
  return platform.os === 'win32' && isWindowsAbsolutePathLike(root)
    ? win32.normalize(root).toLowerCase()
    : posix.normalize(root)
}

// Stable 1.39.7 WorkspaceSlug uses UTF-8 bytes and FNV-1a when a component exceeds 255 bytes.
export function reasonixWorkspaceSlug(root: string): string {
  const slug = root.replace(/[/\\:]/g, '-')
  const bytes = Buffer.from(slug)
  if (bytes.length <= 255) {
    return slug
  }
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }
  let end = 238
  while ((bytes[end] & 0xc0) === 0x80) {
    end--
  }
  return `${bytes.subarray(0, end).toString('utf8')}-${hash.toString(16).padStart(16, '0')}`
}

export function reasonixCollisionProjectName(root: string): string {
  return `@${createHash('sha256').update(root).digest('hex')}`
}

export function resolveReasonixWorkspace(
  layout: ReasonixSessionLayout,
  platform: RemoteHostPlatform,
  knownRoots: readonly string[],
  marker: Buffer | null
): string | null {
  const name = (platform.os === 'win32' ? win32 : posix).basename(layout.projectDirectory)
  if (marker) {
    const text = marker.toString('utf8')
    const root = text.endsWith('\n') ? canonicalRoot(text.slice(0, -1), platform) : null
    if (!root || text !== `${root}\n` || name !== reasonixCollisionProjectName(root)) {
      throw new Error('Invalid Reasonix project ownership marker')
    }
    return root
  }
  const candidates = [...new Set(knownRoots.map((root) => canonicalRoot(root, platform)))].filter(
    (root) => root !== null && reasonixWorkspaceSlug(root) === name
  )
  // A supplied execution-host inventory can match a slug; reversing the slug cannot establish cwd.
  return candidates.length === 1 ? candidates[0] : null
}
