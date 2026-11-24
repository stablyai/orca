import {
  commanderMemoryId,
  commanderMemoryIndexQuery,
  commanderMemoryIndexResult,
  commanderMemoryList,
  commanderMemorySummary,
  commanderWorkerGuidance,
  commanderWorkerProject,
  type CommanderWorkerGuidance,
  type CommanderMemoryIndexQuery,
  type CommanderMemoryIndexResult,
  type CommanderMemoryRevision
} from '../../shared/commander/memory-contract'
import { isHandoffPage, readHandoff } from '../../shared/commander/handoff-content'
import { humanRecurringAnswer } from '../../shared/commander/recurring-answer'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'

function indexPath(query: CommanderMemoryIndexQuery): string {
  const params = new URLSearchParams()
  const { ids, validHandoffsOnly, ...filters } = query
  const path = validHandoffsOnly ? '/handoffs-index' : '/index'
  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined) {
      params.set(name, String(value))
    }
  }
  for (const id of ids ?? []) {
    params.append('id', id)
  }
  return params.size ? `${path}?${params}` : path
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a === b ? 0 : 1
}

function legacyCursor(after: string, recent: boolean) {
  if (!recent) {
    return { pageId: commanderMemoryId.parse(after), createdAt: '' }
  }
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(.+)$/u.exec(after)
  if (!parts) {
    throw new Error('Invalid Commander Memory index cursor.')
  }
  return { pageId: commanderMemoryId.parse(parts[2]), createdAt: parts[1]! }
}

function legacyIndex(
  pages: CommanderMemoryRevision[],
  query: CommanderMemoryIndexQuery
): CommanderMemoryIndexResult {
  const projects = new Set<string>()
  const search = query.q?.trim().toLowerCase()
  const recent = query.order === 'recent'
  const ids = query.ids && new Set(query.ids)
  const cursor = query.after ? legacyCursor(query.after, recent) : null
  type SortKey = Pick<CommanderMemoryRevision, 'pageId' | 'createdAt'>
  function compare(a: SortKey, b: SortKey): number {
    return (recent ? compareIds(b.createdAt, a.createdAt) : 0) || compareIds(a.pageId, b.pageId)
  }
  const visible = pages.filter((page) => {
    if (page.projectId && (!page.deleted || query.includeDeleted || query.includeDeletedProjects)) {
      projects.add(page.projectId)
    }
    if (cursor && compare(page, cursor) <= 0) {
      return false
    }
    if (
      (page.deleted && !query.includeDeleted) ||
      (query.projectId && page.projectId !== query.projectId) ||
      (query.kind && query.kind !== page.kind) ||
      (ids && !ids.has(page.pageId)) ||
      (query.handoffsOnly && !isHandoffPage(page)) ||
      (query.validHandoffsOnly && !readHandoff(page)) ||
      (query.recurringOnly && !humanRecurringAnswer(page))
    ) {
      return false
    }
    return (
      !search ||
      [
        page.title,
        page.body,
        page.kind,
        page.projectId,
        page.actor.type,
        page.actor.id,
        page.createdBy.type,
        page.createdBy.id
      ].some((value) => value?.toLowerCase().includes(search))
    )
  })
  visible.sort(compare)
  const batch = visible.slice(0, 50)
  const last = batch.at(-1)
  return {
    pages: batch.map((page) =>
      commanderMemorySummary.parse({
        ...page,
        recurringQuestion: humanRecurringAnswer(page)?.question
      })
    ),
    projects: [...projects].sort(),
    next:
      visible.length > batch.length && last
        ? recent
          ? `${last.createdAt}|${last.pageId}`
          : last.pageId
        : null
  }
}

export async function readMemoryIndex(
  request: (path: string) => Promise<unknown>,
  raw: CommanderMemoryIndexQuery
): Promise<CommanderMemoryIndexResult> {
  const query = commanderMemoryIndexQuery.parse(raw)
  try {
    return commanderMemoryIndexResult.parse(await request(indexPath(query)))
  } catch (error) {
    if (!(error instanceof OrcaCloudRequestError) || error.statusCode !== 404) {
      throw error
    }
  }
  // Older services lack the requested listing route. The authenticated list preserves its filtering.
  const { pages } = commanderMemoryList.parse(await request(''))
  return legacyIndex(pages, query)
}

export async function readWorkerGuidance(
  request: (path: string) => Promise<unknown>,
  rawProjectId: string
): Promise<CommanderWorkerGuidance> {
  const projectId = commanderWorkerProject.parse(rawProjectId)
  try {
    return commanderWorkerGuidance.parse(
      await request(`/worker-guidance?${new URLSearchParams({ projectId })}`)
    )
  } catch (error) {
    if (!(error instanceof OrcaCloudRequestError) || error.statusCode !== 404) {
      throw error
    }
  }
  const { pages } = commanderMemoryList.parse(await request(''))
  const guidelines: string[] = []
  let truncated = false
  let remaining = 8000
  // Legacy owner lists are sorted by page ID. Preserve their selection order.
  for (const page of pages) {
    if (
      page.deleted ||
      page.kind !== 'guideline' ||
      page.actor.type !== 'human' ||
      page.title === 'Recurring answer' ||
      (page.projectId != null && page.projectId !== projectId)
    ) {
      continue
    }
    const entry = `${page.title} (v${page.version})\n${page.body}`
    const cost = entry.length + 2
    if (cost > remaining) {
      truncated = true
    } else {
      remaining -= cost
      guidelines.push(entry)
    }
  }
  return { guidelines, truncated }
}
