import type { GetProjectViewTableArgs } from '../../../shared/github/project-request-types'
import type { GetProjectViewTableResult } from '../../../shared/github/project-result-types'
import type { GitHubProjectTable } from '../../../shared/github/project-types'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { isRenderableProjectViewLayout } from '../../../shared/github/project-types'
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
      const rank: Record<typeof m, number> = { id: 4, number: 3, name: 2, default: 1 }
      const currentRank = matchStrength ? rank[matchStrength] : 0
      if (!selectedRaw || rank[m] > currentRank) {
        selectedRaw = v
        matchStrength = m
      }
    }
    // Stop on the first match; further pagination spends quota without reranking it.
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
  const noSelector =
    args.viewId === undefined && args.viewNumber === undefined && args.viewName === undefined
  if (!selectedRaw && noSelector) {
    // Prefer tables, but allow roadmap/board defaults when no table view matched.
    selectedRaw =
      viewsSeen.find((v) => v.layout === 'ROADMAP_LAYOUT') ??
      viewsSeen.find((v) => v.layout === 'BOARD_LAYOUT') ??
      null
  }
  if (!selectedRaw) {
    return { ok: false, error: { type: 'not_found', message: 'Could not find the selected view.' } }
  }

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

  // Empty override clears the filter; undefined retains the stored view filter. Neither persists.
  const effectiveQuery =
    typeof args.queryOverride === 'string' ? args.queryOverride : selectedView.filter

  // Layouts share item data, but future unsupported layouts need explicit rejection.
  if (!isRenderableProjectViewLayout(selectedView.layout)) {
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
        // Unchecked runtime layout values can reach this branch despite the closed type union.
        message: `Orca renders table, board, and roadmap views. This is a ${String(selectedView.layout).replace('_LAYOUT', '').toLowerCase()} view.`
      },
      ...(typeof count === 'number' ? { totalCount: count } : {})
    }
  }

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
