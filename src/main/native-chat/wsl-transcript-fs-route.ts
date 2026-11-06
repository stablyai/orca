import { parseWslUncPath } from '../../shared/wsl-paths'

/** Isolate distro/spelling consistently across gate and process ownership.
 * wsl$ and wsl.localhost remain distinct: provider behavior may differ, so each has its own deadlines. */
export function wslTranscriptFsRouteKey(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)/i)
  if (match) {
    return `${match[1].toLowerCase()}/${match[2].trim().toLowerCase()}`
  }
  return parseWslUncPath(path)?.distro.trim().toLowerCase() ?? path
}

export function wslTranscriptFsLaneKey(path: string, priority: 'exact' | 'scan'): string {
  return `${wslTranscriptFsRouteKey(path)}:${priority}`
}
