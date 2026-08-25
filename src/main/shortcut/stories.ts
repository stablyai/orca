import type {
  ShortcutComment,
  ShortcutStory,
  ShortcutStoryFilter,
  ShortcutWorkspaceSelection
} from '../../shared/shortcut-types'
import { acquire, release } from './request-queue'
import { shortcutRequest, type ShortcutClientForWorkspace } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { getWorkspaceMetadata } from './workspace-metadata'
import { mapComment, mapStory } from './story-mapping'
import type { ShortcutRecord } from './api-mapping'

const STORY_SEARCH_TIMEOUT_MS = 30_000
const SEARCH_PAGE_SIZE_MAX = 250

type StorySearchResponse = {
  data?: ShortcutRecord[]
}

type StoryReadFailure = {
  error: unknown
  auth: boolean
}

function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

/** Run against one signal that trips on the caller's abort or the request deadline. */
async function withShortcutDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  run: (deadlineSignal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    controller.abort()
  }
  const timer = setTimeout(abort, timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return null
  }
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

function toStoryReadFailureError(error: unknown): unknown {
  const status = getErrorStatus(error)
  if (
    status === null ||
    !(error instanceof Error) ||
    error.message.startsWith(`Error ${status}:`)
  ) {
    return error
  }
  return new Error(`Error ${status}: ${error.message}`)
}

function shouldSurfaceWorkspaceFailure(
  selection: ShortcutWorkspaceSelection | null | undefined,
  entryCount: number
): boolean {
  // getClients can resolve an omitted selection to the persisted 'all' choice;
  // multi-entry reads need the same resilient fan-out policy as explicit 'all'.
  return selection !== 'all' && entryCount <= 1
}

function sortAndLimitStories(stories: ShortcutStory[], limit: number): ShortcutStory[] {
  return stories
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

// Search-operator query per https://help.shortcut.com search operators; the
// mention name scopes assignment filters to the connected member.
function filterToQuery(filter: ShortcutStoryFilter, mentionName: string): string {
  if (filter === 'assigned') {
    return `owner:${mentionName} !is:done !is:archived`
  }
  if (filter === 'requested') {
    return `requester:${mentionName} !is:done !is:archived`
  }
  if (filter === 'done') {
    return `owner:${mentionName} is:done`
  }
  return '!is:done !is:archived'
}

async function searchStoriesForClient(
  entry: ShortcutClientForWorkspace,
  query: string,
  limit: number,
  signal?: AbortSignal
): Promise<ShortcutStory[]> {
  // Metadata resolves outside the held slot: it pools its own requests, and
  // holding a slot while waiting on it would deadlock a multi-workspace fan-out.
  const metadata = await getWorkspaceMetadata(entry)
  const params = new URLSearchParams({
    query,
    page_size: String(Math.min(limit, SEARCH_PAGE_SIZE_MAX)),
    detail: 'slim'
  })
  await acquire(signal)
  let result: StorySearchResponse
  try {
    result = await shortcutRequest<StorySearchResponse>(
      entry,
      `/api/v3/search/stories?${params.toString()}`,
      { signal }
    )
  } finally {
    release()
  }
  return (result.data ?? []).map((story) => mapStory(entry.workspace, metadata, story))
}

async function runStoriesRead(
  buildQuery: (entry: ShortcutClientForWorkspace) => string,
  limit: number,
  selection?: ShortcutWorkspaceSelection | null,
  signal?: AbortSignal,
  options?: { preserveSingleWorkspaceOrder?: boolean }
): Promise<ShortcutStory[]> {
  const entries = getClients(selection)
  if (entries.length === 0) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const failures: (StoryReadFailure | undefined)[] = Array.from({ length: entries.length })
  const surfaceWorkspaceFailure = shouldSurfaceWorkspaceFailure(selection, entries.length)
  const results = await withShortcutDeadline(signal, STORY_SEARCH_TIMEOUT_MS, (requestSignal) =>
    Promise.all(
      entries.map(async (entry, index) => {
        try {
          return await searchStoriesForClient(entry, buildQuery(entry), safeLimit, requestSignal)
        } catch (error) {
          if (requestSignal.aborted) {
            // Abandoned by the caller: not a workspace failure, so don't clear
            // tokens or mask a real one.
            throw error
          }
          const authFailure = isAuthError(error)
          if (authFailure) {
            clearToken(entry.workspace.id)
          }
          if (surfaceWorkspaceFailure) {
            throw toStoryReadFailureError(error)
          }
          console.warn('[shortcut] story read failed:', error)
          failures[index] = { error: toStoryReadFailureError(error), auth: authFailure }
          return [] as ShortcutStory[]
        }
      })
    )
  )
  // 'all' fan-out: only surface an error when every connected workspace failed,
  // so a partial success (or a genuinely empty result) is not reported as one.
  const recordedFailures = failures.filter(
    (failure): failure is StoryReadFailure => failure !== undefined
  )
  if (recordedFailures.length === entries.length) {
    throw (recordedFailures.find((failure) => !failure.auth) ?? recordedFailures[0]).error
  }
  return entries.length === 1 && options?.preserveSingleWorkspaceOrder
    ? results.flat().slice(0, safeLimit)
    : sortAndLimitStories(results.flat(), safeLimit)
}

export async function listStories(
  filter: ShortcutStoryFilter = 'assigned',
  limit = 30,
  workspaceId?: ShortcutWorkspaceSelection | null
): Promise<ShortcutStory[]> {
  return runStoriesRead(
    (entry) => filterToQuery(filter, entry.workspace.mentionName),
    limit,
    workspaceId
  )
}

export async function searchStories(
  query: string,
  limit = 30,
  workspaceId?: ShortcutWorkspaceSelection | null,
  signal?: AbortSignal
): Promise<ShortcutStory[]> {
  const trimmed = query.trim()
  if (!trimmed) {
    return []
  }
  // Relevance order is meaningful for a single-workspace text search; merged
  // fan-outs fall back to recency like the list reads.
  return runStoriesRead(() => trimmed, limit, workspaceId, signal, {
    preserveSingleWorkspaceOrder: true
  })
}

export async function getStory(
  storyId: string,
  workspaceId?: ShortcutWorkspaceSelection | null
): Promise<ShortcutStory | null> {
  const entries = getClients(workspaceId)
  for (const entry of entries) {
    try {
      const metadata = await getWorkspaceMetadata(entry)
      await acquire()
      let story: ShortcutRecord
      try {
        story = await shortcutRequest<ShortcutRecord>(
          entry,
          `/api/v3/stories/${encodeURIComponent(storyId)}`
        )
      } finally {
        release()
      }
      return mapStory(entry.workspace, metadata, story)
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.workspace.id)
        if (shouldSurfaceWorkspaceFailure(workspaceId, entries.length)) {
          throw error
        }
      } else if (getErrorStatus(error) !== 404) {
        console.warn('[shortcut] getStory failed:', error)
      }
    }
  }
  return null
}

export async function getStoryComments(
  storyId: string,
  workspaceId?: string | null
): Promise<ShortcutComment[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }
  try {
    const metadata = await getWorkspaceMetadata(entry)
    await acquire()
    let comments: unknown[]
    try {
      comments = await shortcutRequest<unknown[]>(
        entry,
        `/api/v3/stories/${encodeURIComponent(storyId)}/comments`
      )
    } finally {
      release()
    }
    return (Array.isArray(comments) ? comments : [])
      .map((comment) => mapComment(metadata, comment))
      .filter((comment): comment is ShortcutComment => comment !== null)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[shortcut] getStoryComments failed:', error)
    return []
  }
}
