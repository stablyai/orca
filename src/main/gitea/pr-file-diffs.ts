import { requestGiteaJson, requestGiteaText } from './client'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'

// One page keeps a huge PR from retaining every changed file.
const DETAIL_PAGE_LIMIT = 100

export type GiteaPRFile = {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'renamed' | 'deleted'
  additions: number
  deletions: number
  isBinary: boolean
  diff?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function repoResource(repo: GiteaRepoRef, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${suffix}`
}

function withTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}

function readQuoted(input: string): { value: string; rest: string } | null {
  if (!input.startsWith('"')) {
    return null
  }
  let value = ''
  for (let index = 1; index < input.length; index += 1) {
    const char = input[index]
    if (char === '\\' && index + 1 < input.length) {
      value += input[index + 1]
      index += 1
      continue
    }
    if (char === '"') {
      return { value, rest: input.slice(index + 1).trimStart() }
    }
    value += char ?? ''
  }
  return null
}

function stripDiffPrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

function gitDiffNewPath(line: string): string | null {
  const prefix = 'diff --git '
  if (!line.startsWith(prefix)) {
    return null
  }
  const rest = line.slice(prefix.length)
  if (rest.startsWith('"')) {
    const first = readQuoted(rest)
    const second = first ? readQuoted(first.rest) : null
    return second ? stripDiffPrefix(second.value) : null
  }
  const separator = rest.indexOf(' b/')
  if (!rest.startsWith('a/') || separator === -1) {
    return null
  }
  return rest.slice(separator + ' b/'.length)
}

function diffPath(chunk: string): string | null {
  const renameTo = /^rename to (.+)$/m.exec(chunk)
  if (renameTo?.[1]) {
    return renameTo[1]
  }
  const firstLine = chunk.split('\n', 1)[0] ?? ''
  return gitDiffNewPath(firstLine)
}

function splitUnifiedDiff(diff: string): Map<string, string> {
  const patches = new Map<string, string>()
  for (const part of diff.split(/^diff --git /m)) {
    if (!part.trim()) {
      continue
    }
    const chunk = withTrailingNewline(`diff --git ${part}`)
    const path = diffPath(chunk)
    if (path) {
      patches.set(path, chunk)
    }
  }
  return patches
}

function fileStatus(status: string): GiteaPRFile['status'] {
  switch (status.trim().toLowerCase()) {
    case 'added':
      return 'added'
    case 'renamed':
      return 'renamed'
    case 'deleted':
    case 'removed':
      return 'deleted'
    default:
      return 'modified'
  }
}

function isBinaryDiff(diff: string): boolean {
  return /^Binary files /m.test(diff)
}

function mapFile(
  record: Record<string, unknown>,
  patches: Map<string, string>
): GiteaPRFile | null {
  const path = readString(record, 'filename')
  if (!path) {
    return null
  }
  const previous = readString(record, 'previous_filename')
  const additions = readNumber(record, 'additions') ?? 0
  const deletions = readNumber(record, 'deletions') ?? 0
  const patch = readString(record, 'patch')
  const diff = patch || patches.get(path) || ''
  return {
    path,
    ...(previous && previous !== path ? { oldPath: previous } : {}),
    status: fileStatus(readString(record, 'status')),
    additions,
    deletions,
    isBinary: isBinaryDiff(diff) || (!diff && additions === 0 && deletions === 0),
    ...(diff ? { diff } : {})
  }
}

export async function fetchGiteaPRFiles(
  repo: GiteaRepoRef,
  index: number,
  connectionId?: string | null,
  localGitOptions?: LocalGitExecOptions
): Promise<GiteaPRFile[]> {
  void connectionId
  void localGitOptions
  const indexPath = encodeURIComponent(String(index))
  const [files, diffText] = await Promise.all([
    requestGiteaJson<unknown>(repo, repoResource(repo, `/pulls/${indexPath}/files`), {
      searchParams: { limit: DETAIL_PAGE_LIMIT }
    }),
    requestGiteaText(repo, repoResource(repo, `/pulls/${indexPath}.diff`))
  ])
  const patches = splitUnifiedDiff(diffText ?? '')
  return records(files).flatMap((record) => {
    const file = mapFile(record, patches)
    return file ? [file] : []
  })
}
