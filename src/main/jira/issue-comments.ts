import type { JiraComment } from '../../shared/types'
import { acquire, clearToken, getClients, isAuthError, jiraRequest, release } from './client'
import { textToAdf } from './adf-markdown'
import { fetchPagedRecords } from './issue-page-fetcher'
import { mapComment } from './issue-mappers'
import { isServerSite, restApiBase, shouldSurfaceSiteFailure } from './issue-rest-routing'
import { toJiraErrorWithStatus } from './jira-request'

export async function addIssueComment(
  key: string,
  body: string,
  siteId?: string | null
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  await acquire()
  try {
    const comment = await jiraRequest<{ id: string }>(
      entry,
      `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}/comment`,
      {
        method: 'POST',
        // Why: Server/DC comment bodies are plain text; Cloud comment bodies require ADF.
        body: JSON.stringify({ body: isServerSite(entry.site) ? body : textToAdf(body) })
      }
    )
    return { ok: true, id: comment.id }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to add comment.' }
  } finally {
    release()
  }
}

export async function getIssueComments(
  key: string,
  siteId?: string | null
): Promise<JiraComment[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const comments = await fetchPagedRecords(entry, 'comments', (startAt, maxResults) => {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        orderBy: 'created',
        startAt: String(startAt)
      })
      return `${restApiBase(entry.site)}/issue/${encodeURIComponent(key)}/comment?${params.toString()}`
    })
    return comments.map((comment) => mapComment(comment, entry.site))
  } catch (error) {
    const surfacedError = toJiraErrorWithStatus(error)
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw surfacedError
    }
    if (shouldSurfaceSiteFailure(siteId, 1)) {
      throw surfacedError
    }
    console.warn('[jira] getIssueComments failed:', error)
    return []
  } finally {
    release()
  }
}
