import type { GetProjectViewTableArgs } from '../../../shared/github/project-request-types'
import type { GetProjectViewTableResult } from '../../../shared/github/project-result-types'
import type { GitHubProjectTable } from '../../../shared/github/project-types'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { assertPositiveInt, assertSlug } from './internals'
import {
  fetchProjectViewsPage,
  fetchViewFieldsContinuation,
  finalizeView,
  matchesSelector,
  type RawProjectView
} from './project-view-config'
import type { RawProjectV2Field } from './project-view-field-normalization'
import { fetchAllItems, fetchItemsCountOnly } from './project-view-items'

// ─── Public: getProjectViewTable ──────────────────────────────────────

export async function getProjectViewTable(
  args: GetProjectViewTableArgs
): Promise<GetProjectViewTableResult> {
  const ownerCheck = assertSlug(args.owner, 'owner')
  if (!ownerCheck.ok) {
    return { ok: false, error: ownerCheck.error }
  }
  const numCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numCheck.ok) {
    return { ok: false, error: numCheck.error }
  }
  if (args.ownerType !== 'organization' && args.ownerType !== 'user') {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'Invalid ownerType.' }
    }
  }

  // Paginate views until a match is found.
  let cursor: string | null = null
  let project: { id: string; title: string; url: string } | null = null
  let selectedRaw: RawProjectView | null = null
  let matchStrength: 'id' | 'number' | 'name' | 'default' | null = null
  const viewsSeen: RawProjectView[] = []
  while (true) {
    const page = await fetchProjectViewsPage({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      host: args.host,
      after: cursor
    })
    if (!page.ok) {
      return { ok: false, error: page.error }
    }
    project = page.project
    for (const v of page.views) {
      viewsSeen.push(v)
      const m = matchesSelector(v, {
        viewId: args.viewId,
        viewNumber: args.viewNumber,
        viewName: args.viewName
      })
      if (m === 'none') {
        continue
      }
      // Precedence: id > number > name > default.
      const rank: Record<typeof m, number> = { id: 4, number: 3, name: 2, default: 1 }
      const currentRank = matchStrength ? rank[matchStrength] : 0
      if (!selectedRaw || rank[m] > currentRank) {
        selectedRaw = v
        matchStrength = m
      }
    }
    // Why: stop on ANY match (incl. 'default' = first table view); walking further pages costs a GraphQL call per page with no re-ranking upside.
    if (selectedRaw) {
      break
    }
    if (!page.hasNextPage) {
      break
    }
    cursor = page.endCursor
    if (typeof cursor !== 'string') {
      break
    }
  }
  if (!project) {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  if (!selectedRaw) {
    return { ok: false, error: { type: 'not_found', message: 'Could not find the selected view.' } }
  }

  // Paginate view fields if necessary.
  let extraFields: RawProjectV2Field[] = []
  const fieldsPi = selectedRaw.fields?.pageInfo
  if (fieldsPi?.hasNextPage === true && typeof fieldsPi.endCursor === 'string' && selectedRaw.id) {
    const cont = await fetchViewFieldsContinuation(selectedRaw.id, fieldsPi.endCursor, args.host)
    if (!cont.ok) {
      return { ok: false, error: cont.error }
    }
    extraFields = cont.fields
  }

  const finalized = finalizeView(selectedRaw, extraFields)
  if (!finalized.ok) {
    return { ok: false, error: finalized.drift }
  }
  const selectedView = finalized.view

  // Why: empty-string override means "no filter"; undefined means "use the view's stored filter". The override is ephemeral, never persisted.
  const effectiveQuery =
    typeof args.queryOverride === 'string' ? args.queryOverride : selectedView.filter

  // Unsupported layout: skip item pagination; best-effort count-only query.
  if (selectedView.layout !== 'TABLE_LAYOUT') {
    const count = await fetchItemsCountOnly({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: effectiveQuery,
      host: args.host
    })
    return {
      ok: false,
      error: {
        type: 'unsupported_layout',
        message: `Orca only renders table views. This is a ${selectedView.layout.replace('_LAYOUT', '').toLowerCase()} view.`
      },
      ...(typeof count === 'number' ? { totalCount: count } : {})
    }
  }

  // Fetch items.
  const items = await fetchAllItems({
    owner: args.owner,
    ownerType: args.ownerType,
    projectNumber: args.projectNumber,
    query: effectiveQuery,
    host: args.host
  })
  if (!items.ok) {
    return {
      ok: false,
      error: items.error,
      ...(typeof items.totalCount === 'number' ? { totalCount: items.totalCount } : {})
    }
  }

  const table: GitHubProjectTable = {
    project: {
      id: project.id,
      host: githubProjectHost(args.host),
      owner: args.owner,
      ownerType: args.ownerType,
      number: args.projectNumber,
      title: project.title,
      url: project.url
    },
    selectedView,
    rows: items.rows,
    totalCount: items.totalCount,
    parentFieldDropped: items.parentFieldDropped
  }
  return { ok: true, data: table }
}
