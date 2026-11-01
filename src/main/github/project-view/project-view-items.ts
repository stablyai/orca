import type { GitHubProjectOwnerType, GitHubProjectRow } from '../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import { projectGhExecOptions, runGraphql } from './internals'
import { driftError, unsupportedItemFieldsFromErrors } from './project-error-classification'
import {
  getUnsupportedItemFields,
  hasParentFieldWarningLogged,
  markItemFieldsUnsupported,
  markParentFieldWarningLogged,
  ownerScopeKey,
  parentFieldProbeInFlight
} from './project-view-cache'
import { ownerQueryRoot } from './project-view-config'
import { fetchItemsPageWithRaw } from './project-view-item-page'
import { normalizeItem, type RawItem } from './project-view-item-normalization'

const ITEM_PAGE_SIZE = 100
const MAX_ITEMS = 500

export async function fetchAllItems(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  host?: string
}): Promise<
  | { ok: true; rows: GitHubProjectRow[]; totalCount: number; parentFieldDropped: boolean }
  | { ok: false; error: GitHubProjectViewError; totalCount?: number }
> {
  const scopeKey = ownerScopeKey(args.owner, args.ownerType, args.host)
  const inFlight = parentFieldProbeInFlight.get(scopeKey)
  if (inFlight && getUnsupportedItemFields(scopeKey).size < 3) {
    await inFlight.catch(() => {})
  }
  const unsupportedFields = new Set(getUnsupportedItemFields(scopeKey))
  const fetchPage = (after: string | null) =>
    fetchItemsPageWithRaw({
      ...args,
      first: ITEM_PAGE_SIZE,
      after,
      unsupportedFields
    })
  const fetchFirstPage = async () => {
    let result = await fetchPage(null)
    while (!result.ok) {
      const missing = unsupportedItemFieldsFromErrors(result.rawErrors, result.stderr).filter(
        (field) => !unsupportedFields.has(field)
      )
      if (missing.length === 0) {
        break
      }
      missing.forEach((field) => unsupportedFields.add(field))
      markItemFieldsUnsupported(scopeKey, missing)
      if (missing.includes('parent') && !hasParentFieldWarningLogged(scopeKey)) {
        console.warn(
          `[project-view] Issue.parent is not available for ${args.owner} on this token — retrying without the parent selection.`
        )
        markParentFieldWarningLogged(scopeKey)
      }
      // Each validation retry removes at least one of the three optional selections.
      result = await fetchPage(null)
    }
    return result
  }
  let first: Awaited<ReturnType<typeof fetchItemsPageWithRaw>>
  if (unsupportedFields.size < 3 && !parentFieldProbeInFlight.has(scopeKey)) {
    let resolveProbe: () => void = () => {}
    parentFieldProbeInFlight.set(
      scopeKey,
      new Promise<void>((resolve) => {
        resolveProbe = resolve
      })
    )
    try {
      first = await fetchFirstPage()
    } finally {
      resolveProbe()
      parentFieldProbeInFlight.delete(scopeKey)
    }
  } else {
    first = await fetchFirstPage()
  }
  const parentFieldDropped = unsupportedFields.has('parent')

  if (!first.ok) {
    return { ok: false, error: first.error }
  }

  if (first.page.totalCount === undefined || first.page.totalCount === null) {
    return { ok: false, error: driftError('items.totalCount missing') }
  }
  const totalCount = first.page.totalCount
  if (first.page.pageInfo?.hasNextPage === undefined) {
    return { ok: false, error: driftError('items.pageInfo.hasNextPage missing'), totalCount }
  }
  if (!Array.isArray(first.page.nodes)) {
    return { ok: false, error: driftError('items.nodes missing'), totalCount }
  }

  if (totalCount > MAX_ITEMS) {
    return {
      ok: false,
      error: { type: 'too_large', message: `View has ${totalCount} items.` },
      totalCount
    }
  }

  const rows: GitHubProjectRow[] = []
  let position = 0
  const appendNodes = (nodes: (RawItem | null)[]): GitHubProjectViewError | null => {
    for (const n of nodes) {
      if (!n) {
        continue
      }
      const norm = normalizeItem(n, position)
      if (!norm.ok) {
        return norm.drift
      }
      rows.push(norm.row)
      position++
    }
    return null
  }
  const e1 = appendNodes(first.page.nodes)
  if (e1) {
    return { ok: false, error: e1, totalCount }
  }

  let hasNext = first.page.pageInfo.hasNextPage === true
  let cursor: string | null | undefined = first.page.pageInfo.endCursor
  while (hasNext) {
    if (typeof cursor !== 'string') {
      return {
        ok: false,
        error: driftError('items.pageInfo.endCursor missing with hasNextPage=true'),
        totalCount
      }
    }
    const next = await fetchPage(cursor)
    if (!next.ok) {
      return { ok: false, error: next.error, totalCount }
    }
    if (!Array.isArray(next.page.nodes)) {
      return { ok: false, error: driftError('items.nodes missing on follow page'), totalCount }
    }
    if (next.page.pageInfo?.hasNextPage === undefined) {
      return {
        ok: false,
        error: driftError('items.pageInfo.hasNextPage missing on follow page'),
        totalCount
      }
    }
    const e2 = appendNodes(next.page.nodes)
    if (e2) {
      return { ok: false, error: e2, totalCount }
    }
    hasNext = next.page.pageInfo.hasNextPage === true
    cursor = next.page.pageInfo.endCursor
  }
  return { ok: true, rows, totalCount, parentFieldDropped }
}

export async function fetchItemsCountOnly(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  host?: string
}): Promise<number | null> {
  const root = ownerQueryRoot(args.ownerType)
  const query = `
    query($owner:String!, $num:Int!, $q:String!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          items(first:1, query:$q) { totalCount }
        }
      }
    }
  `
  const res = await runGraphql<
    Record<string, { projectV2?: { items?: { totalCount?: number } | null } | null } | null>
  >(
    query,
    { owner: args.owner, num: args.projectNumber, q: args.query },
    projectGhExecOptions(args.host)
  )
  if (!res.ok) {
    return null
  }
  const count = res.data[root]?.projectV2?.items?.totalCount
  return typeof count === 'number' ? count : null
}
