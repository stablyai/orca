import { runProcess } from '@orca/process-host'

const LS_TIMEOUT_MS = 5_000
// `ls -le` lists a file's ACL entries on the lines after it, numbered from 0.
const ACL_ENTRY = /^\s+\d+: /

/**
 * Which of `paths` carry an ACL entry, from `ls -lde` output; null when a path's own line is
 * missing (so nothing can be told about it). The `+` after the mode is no proof: `@` replaces it
 * when the file also has extended attributes.
 */
export function parseFilesWithAcl(listing: string, paths: readonly string[]): Set<string> | null {
  const withAcl = new Set<string>()
  const seen = new Set<string>()
  let current: string | null = null
  for (const line of listing.split('\n')) {
    if (ACL_ENTRY.test(line)) {
      if (current === null) {
        return null
      }
      withAcl.add(current)
      continue
    }
    if (line.trim() === '') {
      continue
    }
    // The longest match: one path can end another's line when a folder name ends in a space.
    current =
      paths
        .filter((path) => line.endsWith(` ${path}`))
        .sort((left, right) => right.length - left.length)[0] ?? null
    if (current === null) {
      return null
    }
    seen.add(current)
  }
  return paths.every((path) => seen.has(path)) ? withAcl : null
}

/** macOS: which of `paths` carry an ACL entry; null when `ls` couldn't tell. */
export async function findFilesWithAcl(paths: readonly string[]): Promise<Set<string> | null> {
  if (paths.length === 0) {
    return new Set()
  }
  const result = await runProcess({
    program: '/bin/ls',
    args: ['-lde', '--', ...paths],
    timeoutMs: LS_TIMEOUT_MS,
    maxOutputBytes: 4 * 1024 * 1024
  }).catch(() => null)
  if (
    !result ||
    result.timedOut ||
    result.outputTruncated ||
    result.code !== 0 ||
    result.stderr.trim() !== ''
  ) {
    return null
  }
  return parseFilesWithAcl(result.stdout, paths)
}
