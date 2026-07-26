import { parse, stringify } from 'yaml'
import { RuntimeClientError } from './runtime-client'

export const AGENT_MEMORY_SCHEMA = 'orca.agent-memory/v1'
export const AGENT_MEMORY_ROOT = '.orca/memory'
export const AGENT_MEMORY_ENTRIES = `${AGENT_MEMORY_ROOT}/entries`
export const AGENT_MEMORY_TEMP = `${AGENT_MEMORY_ROOT}/.tmp`
export const AGENT_MEMORY_MAX_ENTRIES = 2_000
export const AGENT_MEMORY_MAX_BODY_BYTES = 64 * 1024
export const AGENT_MEMORY_MAX_FILE_BYTES = 96 * 1024
export const AGENT_MEMORY_MAX_SOURCES = 12
export const AGENT_MEMORY_MAX_SOURCE_LENGTH = 2_048
export const AGENT_MEMORY_MAX_TAGS = 32
export const AGENT_MEMORY_MAX_TITLE_LENGTH = 160
export const AGENT_MEMORY_DEFAULT_LIMIT = 8
export const AGENT_MEMORY_MAX_LIMIT = 32

export const AGENT_MEMORY_KINDS = [
  'architecture',
  'constraint',
  'decision',
  'fact',
  'lesson',
  'task'
] as const

export const AGENT_MEMORY_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const

export type AgentMemoryKind = (typeof AGENT_MEMORY_KINDS)[number]
export type AgentMemoryConfidence = (typeof AGENT_MEMORY_CONFIDENCE_LEVELS)[number]

export type AgentMemoryRecord = {
  id: string
  title: string
  kind: AgentMemoryKind
  confidence: AgentMemoryConfidence
  createdAt: string
  sources: string[]
  tags: string[]
  supersedes?: string
  body: string
}

export type AgentMemoryStatus = {
  record: AgentMemoryRecord
  supersededBy?: string[]
}

export type AgentMemorySearchMatch = AgentMemoryStatus & {
  score: number
  snippet: string
  citation: string
  relativePath: string
}

type MemoryFrontmatter = {
  schema: string
  id: string
  title: string
  kind: AgentMemoryKind
  confidence: AgentMemoryConfidence
  created_at: string
  sources: string[]
  tags?: string[]
  supersedes?: string
}

const MEMORY_ID_PATTERN = /^mem_\d{8}T\d{6}Z_[a-z0-9-]{1,48}_[a-f0-9]{8}$/
const MEMORY_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/

function invalidMemory(message: string): never {
  throw new RuntimeClientError('agent_memory_invalid', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string, sourcePath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidMemory(`${sourcePath} has an invalid ${field} field.`)
  }
  return value.trim()
}

function requiredStringArray(value: unknown, field: string, sourcePath: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalidMemory(`${sourcePath} must declare at least one ${field} value.`)
  }
  const entries = value.map((entry) => requiredString(entry, field, sourcePath))
  return [...new Set(entries)]
}

export function assertMemoryId(id: string): void {
  if (!MEMORY_ID_PATTERN.test(id)) {
    throw new RuntimeClientError('invalid_argument', `Invalid agent memory id: ${id}`)
  }
}

export function normalizeMemoryTags(tags: readonly string[]): string[] {
  const normalized = tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
  for (const tag of normalized) {
    if (!MEMORY_TAG_PATTERN.test(tag)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Invalid memory tag "${tag}". Use 1-40 lowercase letters, numbers, dots, underscores, or hyphens.`
      )
    }
  }
  return [...new Set(normalized)]
}

export function renderAgentMemory(record: AgentMemoryRecord): string {
  const frontmatter: MemoryFrontmatter = {
    schema: AGENT_MEMORY_SCHEMA,
    id: record.id,
    title: record.title,
    kind: record.kind,
    confidence: record.confidence,
    created_at: record.createdAt,
    sources: record.sources,
    ...(record.tags.length > 0 ? { tags: record.tags } : {}),
    ...(record.supersedes ? { supersedes: record.supersedes } : {})
  }
  return `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${record.body.trim()}\n`
}

export function parseAgentMemory(markdown: string, sourcePath: string): AgentMemoryRecord {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(markdown)
  if (!match) {
    invalidMemory(`${sourcePath} is missing YAML frontmatter.`)
  }

  let frontmatter: unknown
  try {
    frontmatter = parse(match[1])
  } catch (error) {
    invalidMemory(
      `${sourcePath} has invalid YAML: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isRecord(frontmatter)) {
    invalidMemory(`${sourcePath} frontmatter must be a mapping.`)
  }

  const schema = requiredString(frontmatter.schema, 'schema', sourcePath)
  if (schema !== AGENT_MEMORY_SCHEMA) {
    invalidMemory(`${sourcePath} uses unsupported schema "${schema}".`)
  }
  const id = requiredString(frontmatter.id, 'id', sourcePath)
  assertMemoryId(id)
  const kind = requiredString(frontmatter.kind, 'kind', sourcePath)
  if (!AGENT_MEMORY_KINDS.includes(kind as AgentMemoryKind)) {
    invalidMemory(`${sourcePath} has unsupported kind "${kind}".`)
  }
  const confidence = requiredString(frontmatter.confidence, 'confidence', sourcePath)
  if (!AGENT_MEMORY_CONFIDENCE_LEVELS.includes(confidence as AgentMemoryConfidence)) {
    invalidMemory(`${sourcePath} has unsupported confidence "${confidence}".`)
  }
  const createdAt = requiredString(frontmatter.created_at, 'created_at', sourcePath)
  if (!Number.isFinite(Date.parse(createdAt))) {
    invalidMemory(`${sourcePath} has an invalid created_at timestamp.`)
  }
  const supersedes =
    frontmatter.supersedes === undefined
      ? undefined
      : requiredString(frontmatter.supersedes, 'supersedes', sourcePath)
  if (supersedes) {
    assertMemoryId(supersedes)
  }
  const body = match[2].trim()
  if (body.length === 0) {
    invalidMemory(`${sourcePath} has an empty body.`)
  }
  if (Buffer.byteLength(body, 'utf8') > AGENT_MEMORY_MAX_BODY_BYTES) {
    invalidMemory(`${sourcePath} body exceeds the agent-memory limit.`)
  }
  const title = requiredString(frontmatter.title, 'title', sourcePath)
  if (title.length > AGENT_MEMORY_MAX_TITLE_LENGTH) {
    invalidMemory(`${sourcePath} title exceeds the agent-memory limit.`)
  }
  const sources = requiredStringArray(frontmatter.sources, 'sources', sourcePath)
  if (
    sources.length > AGENT_MEMORY_MAX_SOURCES ||
    sources.some((source) => source.length > AGENT_MEMORY_MAX_SOURCE_LENGTH)
  ) {
    invalidMemory(`${sourcePath} sources exceed the agent-memory limits.`)
  }
  const tags =
    frontmatter.tags === undefined
      ? []
      : normalizeMemoryTags(requiredStringArray(frontmatter.tags, 'tags', sourcePath))
  if (tags.length > AGENT_MEMORY_MAX_TAGS) {
    invalidMemory(`${sourcePath} tags exceed the agent-memory limit.`)
  }

  return {
    id,
    title,
    kind: kind as AgentMemoryKind,
    confidence: confidence as AgentMemoryConfidence,
    createdAt,
    sources,
    tags,
    ...(supersedes ? { supersedes } : {}),
    body
  }
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []
}

function occurrences(haystack: string, needle: string): number {
  let count = 0
  let offset = 0
  while (count < 5) {
    const index = haystack.indexOf(needle, offset)
    if (index < 0) {
      break
    }
    count += 1
    offset = index + needle.length
  }
  return count
}

function memoryScore(record: AgentMemoryRecord, query: string, queryTokens: string[]): number {
  const title = record.title.toLocaleLowerCase()
  const body = record.body.toLocaleLowerCase()
  const sources = record.sources.join(' ').toLocaleLowerCase()
  const tags = record.tags.join(' ').toLocaleLowerCase()
  let score = title.includes(query) ? 10 : body.includes(query) ? 3 : 0
  for (const token of queryTokens) {
    score += title.includes(token) ? 8 : 0
    score += tags.includes(token) ? 5 : 0
    score += record.kind === token ? 3 : 0
    score += sources.includes(token) ? 2 : 0
    score += occurrences(body, token)
  }
  return score
}

export function memorySnippet(body: string, query: string, maxLength = 360): string {
  const normalizedQuery = query.toLocaleLowerCase()
  const lowerBody = body.toLocaleLowerCase()
  const firstToken = tokens(query)[0] ?? normalizedQuery
  const matchIndex = Math.max(0, lowerBody.indexOf(normalizedQuery), lowerBody.indexOf(firstToken))
  const start = Math.max(0, matchIndex - Math.floor(maxLength / 4))
  const end = Math.min(body.length, start + maxLength)
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`
}

export function searchAgentMemories(
  records: readonly AgentMemoryRecord[],
  queryText: string,
  options: { includeSuperseded: boolean; limit: number; kind?: AgentMemoryKind; tag?: string }
): AgentMemorySearchMatch[] {
  const query = queryText.trim().toLocaleLowerCase()
  if (query.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Agent memory search requires a query.')
  }
  const queryTokens = [...new Set(tokens(query))]
  const supersededBy = new Map<string, string[]>()
  for (const record of records) {
    if (record.supersedes) {
      const successors = supersededBy.get(record.supersedes) ?? []
      successors.push(record.id)
      successors.sort((left, right) => left.localeCompare(right))
      supersededBy.set(record.supersedes, successors)
    }
  }

  return records
    .filter((record) => options.includeSuperseded || !supersededBy.has(record.id))
    .filter((record) => !options.kind || record.kind === options.kind)
    .filter((record) => !options.tag || record.tags.includes(options.tag))
    .map((record) => ({
      record,
      score: memoryScore(record, query, queryTokens),
      snippet: memorySnippet(record.body, query),
      citation: `[memory:${record.id}]`,
      relativePath: `${AGENT_MEMORY_ENTRIES}/${record.id}.md`,
      ...(supersededBy.has(record.id) ? { supersededBy: supersededBy.get(record.id) } : {})
    }))
    .filter((match) => match.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.record.createdAt.localeCompare(left.record.createdAt) ||
        left.record.id.localeCompare(right.record.id)
    )
    .slice(0, options.limit)
}
