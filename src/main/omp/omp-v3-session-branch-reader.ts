import { isAbsolute } from 'node:path'
import { isRecord } from '../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { OmpAuxiliaryDerivationError } from './omp-auxiliary-conversation-error'

const SESSION_VERSION = 3

export type OmpSessionEntry = Record<string, unknown> & {
  type: string
  id: string
  parentId: string | null
  activeLeafId?: string | null
}

export type OmpSessionHeader = Record<string, unknown> & {
  type: 'session'
  version: 3
  id: string
  timestamp: string
  cwd: string
  additionalDirectories?: string[]
  providerPromptCacheKey?: string
  taskPromptCacheKey?: string
}

function invalidSource(message: string): never {
  throw new OmpAuxiliaryDerivationError('invalid-source', message)
}

function isTitleSlot(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === 'title' &&
    value.v === 1 &&
    typeof value.title === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.pad === 'string'
  )
}

function validateHeader(raw: unknown, sourcePath: string): OmpSessionHeader {
  if (!isRecord(raw) || raw.type !== 'session') {
    invalidSource(`OMP session header is missing or malformed: ${sourcePath}`)
  }
  if (raw.version !== SESSION_VERSION) {
    throw new OmpAuxiliaryDerivationError(
      'unsupported-version',
      `OMP auxiliary derivation requires session version ${SESSION_VERSION}: ${sourcePath}`
    )
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    invalidSource(`OMP session header has no id: ${sourcePath}`)
  }
  if (typeof raw.timestamp !== 'string') {
    invalidSource(`OMP session header has no timestamp: ${sourcePath}`)
  }
  if (typeof raw.cwd !== 'string' || raw.cwd.length === 0 || !isAbsolute(raw.cwd)) {
    invalidSource(`OMP session header has no absolute cwd: ${sourcePath}`)
  }
  if (
    raw.additionalDirectories !== undefined &&
    (!Array.isArray(raw.additionalDirectories) ||
      !raw.additionalDirectories.every((directory) => typeof directory === 'string'))
  ) {
    invalidSource(`OMP session header has malformed additionalDirectories: ${sourcePath}`)
  }
  for (const key of ['providerPromptCacheKey', 'taskPromptCacheKey'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      invalidSource(`OMP session header has malformed ${key}: ${sourcePath}`)
    }
  }
  return raw as OmpSessionHeader
}

function readSessionFile(
  content: string,
  sourcePath: string
): { header: OmpSessionHeader; entries: OmpSessionEntry[]; byId: Map<string, OmpSessionEntry> } {
  const lines = content.split('\n')
  // The final element is EOF's empty string or an in-flight, non-newline-terminated fragment.
  lines.pop()
  let index = 0
  while (index < lines.length && lines[index].trim().length === 0) {
    index++
  }
  if (index < lines.length) {
    try {
      if (isTitleSlot(JSON.parse(lines[index].trim()))) {
        index++
      }
    } catch {
      // A malformed title slot is a malformed header, same as OMP's loader.
    }
  }
  while (index < lines.length && lines[index].trim().length === 0) {
    index++
  }
  if (index >= lines.length) {
    invalidSource(`OMP session header is missing or malformed: ${sourcePath}`)
  }
  let rawHeader: unknown
  try {
    rawHeader = JSON.parse(lines[index].trim())
  } catch {
    invalidSource(`OMP session header is not valid JSON: ${sourcePath}`)
  }
  const header = validateHeader(rawHeader, sourcePath)
  index++
  const entries: OmpSessionEntry[] = []
  const byId = new Map<string, OmpSessionEntry>()
  for (; index < lines.length; index++) {
    const line = lines[index].trim()
    if (line.length === 0) {
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      // Match OMP's lenient JSONL loader: a malformed complete record is skipped.
      continue
    }
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      continue
    }
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      invalidSource(`OMP session entry has no id: ${sourcePath}`)
    }
    if (raw.parentId !== null && typeof raw.parentId !== 'string') {
      invalidSource(`OMP session entry ${raw.id} has no valid parentId`)
    }
    if (
      raw.activeLeafId !== undefined &&
      raw.activeLeafId !== null &&
      typeof raw.activeLeafId !== 'string'
    ) {
      invalidSource(`OMP session entry ${raw.id} has a malformed activeLeafId`)
    }
    if (byId.has(raw.id)) {
      invalidSource(`OMP session entry id is duplicated: ${raw.id}`)
    }
    const entry = raw as OmpSessionEntry
    entries.push(entry)
    byId.set(entry.id, entry)
  }
  return { header, entries, byId }
}

function resolveLeafId(entries: readonly OmpSessionEntry[]): string | null {
  const last = entries.at(-1)
  if (!last) {
    return null
  }
  const selected = last.activeLeafId !== undefined ? last.activeLeafId : last.id
  if (selected === null || selected === last.id || entries.some((entry) => entry.id === selected)) {
    return selected
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if ((entry.activeLeafId !== undefined ? entry.activeLeafId : entry.id) === entry.id) {
      return entry.id
    }
  }
  return null
}

function collectBranch(
  leafId: string | null,
  byId: ReadonlyMap<string, OmpSessionEntry>,
  sourcePath: string
): OmpSessionEntry[] {
  if (leafId === null) {
    return []
  }
  const branch: OmpSessionEntry[] = []
  const seen = new Set<string>()
  let current: string | null = leafId
  while (current !== null) {
    if (seen.has(current)) {
      invalidSource(`OMP session branch contains a parent cycle at ${current}: ${sourcePath}`)
    }
    seen.add(current)
    const entry = byId.get(current)
    if (!entry) {
      invalidSource(`OMP session branch references a missing entry ${current}: ${sourcePath}`)
    }
    branch.push(entry)
    current = entry.parentId
  }
  branch.reverse()
  return branch
}

export function readOmpSessionBranch(
  content: string,
  sourcePath: string
): { header: OmpSessionHeader; branch: OmpSessionEntry[] } {
  const { header, entries, byId } = readSessionFile(content, sourcePath)
  return { header, branch: collectBranch(resolveLeafId(entries), byId, sourcePath) }
}
