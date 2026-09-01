import type { GitHubProjectOwnerType, GitHubProjectRow } from '../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import { projectGhExecOptions, runGraphql } from './internals'
import { driftError, errorsIndicateParentField } from './project-error-classification'
import {
  hasParentFieldRetried,
  hasParentFieldWarningLogged,
  markParentFieldRetried,
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
  // Why: isolate missing Issue.parent capability by owner, type, and host.
  const scopeKey = ownerScopeKey(args.owner, args.ownerType, args.host)
  // Why: await the same-scope probe, then re-read state because it may have changed.
  const inFlight = parentFieldProbeInFlight.get(scopeKey)
  if (inFlight) {
    await inFlight.catch(() => {})
  }
  let includeParent = !hasParentFieldRetried(scopeKey)
  let parentFieldDropped = !includeParent
  // Single-flight the with-parent probe per owner; assign the in-flight promise synchronously (no await between get() and set()) so callers share one probe.
  let first: Awaited<ReturnType<typeof fetchItemsPageWithRaw>>
  let probePromise: Promise<Awaited<ReturnType<typeof fetchItemsPageWithRaw>>> | null = null
  if (includeParent && !parentFieldProbeInFlight.has(scopeKey)) {
    let resolveProbe: () => void = () => {}
    const probe = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })
    parentFieldProbeInFlight.set(scopeKey, probe)
    probePromise = (async () => {
      try {
        const result = await fetchItemsPageWithRaw({
          owner: args.owner,
          ownerType: args.ownerType,
          projectNumber: args.projectNumber,
          query: args.query,
          first: ITEM_PAGE_SIZE,
          after: null,
          includeParent: true,
          host: args.host
        })
        // Why: set the retried flag BEFORE resolving/clearing the probe so siblings awoken on inFlight.catch() see it and don't fire duplicate with-parent probes.
        if (!result.ok && errorsIndicateParentField(result.rawErrors, result.stderr)) {
          markParentFieldRetried(scopeKey)
        }
        return result
      } finally {
        resolveProbe()
        parentFieldProbeInFlight.delete(scopeKey)
      }
    })()
    first = await probePromise
  } else {
    first = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: null,
      includeParent,
      host: args.host
    })
  }
  if (!first.ok && includeParent && errorsIndicateParentField(first.rawErrors, first.stderr)) {
    // Retry the whole table without parent; mark this owner retried so later fetches skip the probe (other owners unaffected).
    markParentFieldRetried(scopeKey)
    includeParent = false
    parentFieldDropped = true
    if (!hasParentFieldWarningLogged(scopeKey)) {
      console.warn(
        `[project-view] Issue.parent is not available for ${args.owner} on this token — retrying without the parent selection.`
      )
      markParentFieldWarningLogged(scopeKey)
    }
    first = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: null,
      includeParent: false,
      host: args.host
    })
  }
  if (!first.ok) {
    return { ok: false, error: first.error }
  }

  // Drift guards
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

  // Size cap
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

  // Paginate
  let hasNext = first.page.pageInfo.hasNextPage === true
  let cursor: string | null | undefined = first.page.pageInfo.endCursor
  if (hasNext && typeof cursor !== 'string') {
    return {
      ok: false,
      error: driftError('items.pageInfo.endCursor missing with hasNextPage=true'),
      totalCount
    }
  }
  while (hasNext) {
    const next = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: cursor as string,
      includeParent,
      host: args.host
    })
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
    if (hasNext && typeof cursor !== 'string') {
      return {
        ok: false,
        error: driftError('items.pageInfo.endCursor missing with hasNextPage=true'),
        totalCount
      }
    }
  }
  return { ok: true, rows, totalCount, parentFieldDropped }
}

// ─── Cheap count-only query (for unsupported_layout) ──────────────────

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
