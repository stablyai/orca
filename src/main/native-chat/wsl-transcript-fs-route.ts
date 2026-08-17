import { parseWslUncPath } from '../../shared/wsl-paths'

/**
 * The isolation unit for WSL transcript filesystem work: one stalled distro
 * must not fast-fail or strand work on any other. Shared by the gate's
 * admission and by the ungated close queue so both isolate on the same key.
 *
 * wsl$ and wsl.localhost spellings of one distro stay distinct routes on
 * purpose (provider spelling can change behavior), so a stuck spelling never
 * fast-fails its twin — the twin is bounded by its own waiter deadlines.
 */
export function wslTranscriptFsRouteKey(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)/i)
  if (match) {
    return `${match[1].toLowerCase()}/${match[2].trim().toLowerCase()}`
  }
  return parseWslUncPath(path)?.distro.trim().toLowerCase() ?? path
}
