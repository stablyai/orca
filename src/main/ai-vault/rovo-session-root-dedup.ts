import { parseWslUncPath } from '../../shared/wsl-paths'

// Why: the standalone Rovo CLI copied ~/.rovodev/sessions into ~/.rovo/sessions, so most
// legacy sessions exist in both roots; list the current copy once and keep legacy-only ones.

function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]/).filter((segment) => segment.length > 0)
}

function isLegacyRovoPath(filePath: string): boolean {
  const segments = pathSegments(filePath)
  return segments.some(
    (segment, index) => segment === '.rovodev' && segments[index + 1] === 'sessions'
  )
}

// Session identity is the `<id>` directory holding metadata.json, scoped per execution host.
function rovoSessionKey(filePath: string): string {
  const wslPath = parseWslUncPath(filePath)
  const namespace = wslPath ? `wsl:${wslPath.distro.toLowerCase()}` : 'native'
  return `${namespace}:${pathSegments(filePath).at(-2) ?? ''}`
}

export function dedupeRovoLegacySessionCopies<T extends { agent: string; file: { path: string } }>(
  candidates: T[]
): T[] {
  const currentKeys = new Set(
    candidates
      .filter((c) => c.agent === 'rovo' && !isLegacyRovoPath(c.file.path))
      .map((c) => rovoSessionKey(c.file.path))
  )
  return candidates.filter(
    (c) =>
      c.agent !== 'rovo' ||
      !isLegacyRovoPath(c.file.path) ||
      !currentKeys.has(rovoSessionKey(c.file.path))
  )
}
