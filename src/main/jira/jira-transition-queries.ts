import { requireStrictJiraSite } from './jira-read-failure'
import type { JiraProjectStatusOrder, JiraTransition } from '../../shared/jira/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, JiraApiError, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { mapCreateField, mapStatus } from './jira-issue-mapping'
import {
  asFiniteNumber,
  asIdentifier,
  asRecord,
  asString,
  type JiraPagedResponse,
  type JiraRecord
} from './jira-record-pages'

export async function listTransitions(
  key: string,
  siteId?: string | null,
  strict = false
): Promise<JiraTransition[]> {
  const entries = getClients(siteId)
  requireStrictJiraSite(entries, siteId, strict)
  const entry = entries[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const issuePath = `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/transitions`
    let response: { transitions?: JiraRecord[] }
    try {
      response = await jiraRequest(entry, `${issuePath}?expand=transitions.fields`)
    } catch (error) {
      if (!(error instanceof JiraApiError) || ![400, 403, 404].includes(error.status ?? 0)) {
        throw error
      }
      response = await jiraRequest(entry, issuePath)
    }
    return (response.transitions ?? []).map((transition) => ({
      id: asString(transition.id),
      name: asString(transition.name),
      to: mapStatus(transition.to),
      fields: transition.fields
        ? Object.entries(asRecord(transition.fields))
            .map(([fieldKey, field]) => mapCreateField(field, fieldKey))
            .filter((field) => field !== null)
        : undefined
    }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listTransitions failed:', error)
    if (strict) {
      throw error
    }
    return []
  } finally {
    release()
  }
}

export async function getProjectStatusOrder(
  projectKey: string,
  siteId?: string | null
): Promise<JiraProjectStatusOrder> {
  // Omitted siteId can resolve to all-sites; board metadata needs one owning connection.
  const entries = getClients(siteId)
  const entry = entries.length === 1 ? entries[0] : undefined
  if (!entry) {
    return { statusIdsByColumn: [] }
  }
  await acquire()
  try {
    // Without a board picker, ambiguous projects keep alphabetical status order.
    const params = new URLSearchParams({ projectKeyOrId: projectKey, maxResults: '2' })
    const boardsResponse = await jiraRequest<JiraPagedResponse<JiraRecord>>(
      entry,
      `/rest/agile/1.0/board?${params.toString()}`
    )
    const boards = boardsResponse.values ?? []
    const boardCount = asFiniteNumber(boardsResponse.total)
    const singleBoardIsProven =
      boards.length === 1 &&
      boardsResponse.isLast !== false &&
      (boardCount === 1 || (boardCount === null && boardsResponse.isLast === true))
    const boardId = singleBoardIsProven ? asIdentifier(asRecord(boards[0]).id) : ''
    if (!boardId) {
      return { statusIdsByColumn: [] }
    }

    const configResponse = await jiraRequest<unknown>(
      entry,
      `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/configuration`
    )
    const columns = asRecord(asRecord(configResponse).columnConfig).columns
    if (!Array.isArray(columns)) {
      return { statusIdsByColumn: [] }
    }

    // Use status IDs already on issues to avoid metadata fetches and ambiguous duplicate names.
    const seenStatusIds = new Set<string>()
    const statusIdsByColumn: string[][] = []
    const boardColumns: NonNullable<JiraProjectStatusOrder['columns']> = []
    for (const column of columns) {
      const statuses = asRecord(column).statuses
      if (!Array.isArray(statuses)) {
        continue
      }
      const columnStatusIds: string[] = []
      for (const status of statuses) {
        const statusId = asIdentifier(asRecord(status).id)
        if (statusId && !seenStatusIds.has(statusId)) {
          seenStatusIds.add(statusId)
          columnStatusIds.push(statusId)
        }
      }
      if (columnStatusIds.length > 0) {
        statusIdsByColumn.push(columnStatusIds)
      }
      const name = asString(asRecord(column).name).trim()
      if (name) {
        boardColumns.push({ name, statusIds: columnStatusIds })
      }
    }
    return { statusIdsByColumn, ...(boardColumns.length ? { columns: boardColumns } : {}) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] getProjectStatusOrder failed:', error)
    return { statusIdsByColumn: [] }
  } finally {
    release()
  }
}
