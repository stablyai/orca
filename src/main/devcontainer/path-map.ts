/**
 * Host ↔ container path translation for devcontainer execution hosts.
 *
 * A devcontainer bind-mounts the project from the host (e.g. macOS
 * `/Users/me/work/app`) into the container (e.g. `/workspaces/app`). Orca
 * manages git/files host-side on the bind-mounted path, but the agent's PTY
 * runs *inside* the container, so a worktree's host path must be translated to
 * its in-container path before `docker exec -w`, and container paths reported by
 * in-container tooling must be mapped back to the host.
 *
 * Both ends are POSIX (macOS host, Linux container), so translation is pure
 * POSIX-path arithmetic over the container's mount table (`docker inspect`
 * `.Mounts[]`). No filesystem access — keep this deterministic and unit-tested.
 */
import { posix } from 'path'
import type { ContainerMount } from '../../shared/devcontainer-types'

export type { ContainerMount }

type MountSide = keyof ContainerMount

/** Normalize a POSIX path: collapse `.`/`..`, drop any trailing slash (except root). */
function normalize(input: string): string {
  const normalized = posix.normalize(input)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/** True when `candidate` equals `base` or sits beneath it on a path boundary.
 *  The boundary check stops `/a/app` from matching `/a/app2`. */
function isWithin(base: string, candidate: string): boolean {
  if (base === candidate) {
    return true
  }
  return candidate.startsWith(base === '/' ? '/' : `${base}/`)
}

/** Remainder of `full` relative to ancestor `base` (no leading slash). '' when equal. */
function relativeTail(base: string, full: string): string {
  if (base === full) {
    return ''
  }
  return full.slice(base === '/' ? 1 : base.length + 1)
}

function translate(
  path: string,
  mounts: readonly ContainerMount[],
  from: MountSide
): string | null {
  // Only absolute paths are meaningful here; a relative path has no host/container identity.
  if (!path.startsWith('/')) {
    return null
  }
  const to: MountSide = from === 'source' ? 'destination' : 'source'
  const target = normalize(path)

  // Why longest-prefix: nested mounts (e.g. the repo and a mount inside it) can
  // both be ancestors; the most specific one owns the path.
  let best: ContainerMount | null = null
  let bestBaseLength = -1
  for (const mount of mounts) {
    const base = normalize(mount[from])
    if (base.startsWith('/') && isWithin(base, target) && base.length > bestBaseLength) {
      best = mount
      bestBaseLength = base.length
    }
  }
  if (!best) {
    return null
  }

  const base = normalize(best[from])
  const dest = normalize(best[to])
  const tail = relativeTail(base, target)
  return tail ? posix.join(dest, tail) : dest
}

/** Translate a host path to its in-container path, or null if not under any mount. */
export function hostToContainer(
  hostPath: string,
  mounts: readonly ContainerMount[]
): string | null {
  return translate(hostPath, mounts, 'source')
}

/** Translate an in-container path back to its host path, or null if not under any mount. */
export function containerToHost(
  containerPath: string,
  mounts: readonly ContainerMount[]
): string | null {
  return translate(containerPath, mounts, 'destination')
}
