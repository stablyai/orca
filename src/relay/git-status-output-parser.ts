export function parseStatusChar(char: string): string {
  switch (char) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

/**
 * Parse `git status --porcelain=v2` output into structured entries.
 * Does NOT handle unmerged entries (those require worktree access).
 */
export function parseStatusOutput(stdout: string): {
  entries: Record<string, unknown>[]
  unmergedLines: string[]
  head?: string
  branch?: string
  upstreamStatus: {
    hasUpstream: boolean
    upstreamName?: string
    ahead: number
    behind: number
  }
} {
  const entries: Record<string, unknown>[] = []
  const unmergedLines: string[] = []
  let head: string | undefined
  let branch: string | undefined
  let upstreamName: string | undefined
  let upstreamAheadBehind: { ahead: number; behind: number } | null = null

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }

    if (line.startsWith('# branch.oid ')) {
      head = line.slice('# branch.oid '.length).trim()
      continue
    }

    if (line.startsWith('# branch.head ')) {
      const branchHead = line.slice('# branch.head '.length).trim()
      branch = branchHead && branchHead !== '(detached)' ? `refs/heads/${branchHead}` : ''
      continue
    }

    if (line.startsWith('# branch.upstream ')) {
      upstreamName = line.slice('# branch.upstream '.length).trim() || undefined
      continue
    }

    if (line.startsWith('# branch.ab ')) {
      upstreamAheadBehind = parseBranchAheadBehind(line)
      continue
    }

    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const indexStatus = xy[0]
      const worktreeStatus = xy[1]

      if (line.startsWith('2 ')) {
        // Why: porcelain v2 type-2 format is `2 XY sub mH mI mW hH hI Xscore path\torigPath`.
        // The new path is the last space-delimited token before the tab; origPath follows the tab.
        const tabParts = line.split('\t')
        const spaceParts = tabParts[0].split(' ')
        const filePath = spaceParts.at(-1)!
        const oldPath = tabParts[1]
        if (indexStatus !== '.') {
          entries.push({
            path: filePath,
            status: parseStatusChar(indexStatus),
            area: 'staged',
            oldPath
          })
        }
        if (worktreeStatus !== '.') {
          entries.push({
            path: filePath,
            status: parseStatusChar(worktreeStatus),
            area: 'unstaged',
            oldPath
          })
        }
      } else {
        const filePath = parts.slice(8).join(' ')
        if (indexStatus !== '.') {
          entries.push({ path: filePath, status: parseStatusChar(indexStatus), area: 'staged' })
        }
        if (worktreeStatus !== '.') {
          entries.push({
            path: filePath,
            status: parseStatusChar(worktreeStatus),
            area: 'unstaged'
          })
        }
      }
    } else if (line.startsWith('? ')) {
      entries.push({ path: line.slice(2), status: 'untracked', area: 'untracked' })
    } else if (line.startsWith('u ')) {
      unmergedLines.push(line)
    }
  }

  return {
    entries,
    unmergedLines,
    head,
    branch,
    upstreamStatus: upstreamName
      ? {
          hasUpstream: true,
          upstreamName,
          ahead: upstreamAheadBehind?.ahead ?? 0,
          behind: upstreamAheadBehind?.behind ?? 0
        }
      : { hasUpstream: false, ahead: 0, behind: 0 }
  }
}

function parseBranchAheadBehind(line: string): { ahead: number; behind: number } | null {
  const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
  if (!match) {
    return null
  }
  return {
    ahead: Number.parseInt(match[1], 10),
    behind: Number.parseInt(match[2], 10)
  }
}
