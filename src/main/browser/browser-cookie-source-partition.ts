import type { CookieClearPartitionKey } from './browser-cookie-import-clear'

// Why (STA-4300): a partition identity that cannot be read faithfully must skip the cookie, never
// downgrade it. An unpartitioned write of a partitioned cookie looks like a success and leaves the
// site unable to see its own session — the failure mode that produced STA-4013/4061/4090/4170.
export type SourcePartitionRead =
  | { status: 'unpartitioned' }
  | { status: 'partitioned'; partitionKey: CookieClearPartitionKey }
  | { status: 'unreadable'; reason: string }

const CHROMIUM_PARTITION_SITE_COLUMN = 'top_frame_site_key'
const CHROMIUM_CROSS_SITE_ANCESTOR_COLUMN = 'has_cross_site_ancestor'

const UNPARTITIONED: SourcePartitionRead = { status: 'unpartitioned' }

function readSqliteFlag(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') {
    return raw
  }
  if (typeof raw === 'bigint') {
    return raw === 0n ? false : raw === 1n ? true : null
  }
  if (typeof raw === 'number') {
    return raw === 0 ? false : raw === 1 ? true : null
  }
  return null
}

export function normalizeCookiePartitionSite(raw: string): string | null {
  try {
    const site = new URL(raw)
    if (
      (site.protocol !== 'http:' && site.protocol !== 'https:') ||
      !site.hostname ||
      site.username ||
      site.password ||
      site.port ||
      site.pathname !== '/' ||
      site.search ||
      site.hash
    ) {
      return null
    }
    return site.origin
  } catch {
    return null
  }
}

/**
 * Reads a Chromium cookie row's partition identity.
 *
 * Chromium stores the partition as `top_frame_site_key` (empty string when unpartitioned) plus
 * `has_cross_site_ancestor`, which older schemas predate. Both halves are required: a partition key
 * written with the wrong ancestor bit files the cookie under a partition the site never reads, which
 * is indistinguishable from losing it.
 */
export function readChromiumRowPartition(
  sourceRow: Record<string, unknown>,
  sourceColumns: ReadonlySet<string>
): SourcePartitionRead {
  // Why: a schema without the column predates cookie partitioning, so every row is genuinely
  // unpartitioned — that is a faithful read, not a missing one.
  if (!sourceColumns.has(CHROMIUM_PARTITION_SITE_COLUMN)) {
    return UNPARTITIONED
  }

  const rawSite = sourceRow[CHROMIUM_PARTITION_SITE_COLUMN]
  if (rawSite === '') {
    return UNPARTITIONED
  }
  if (typeof rawSite !== 'string') {
    return { status: 'unreadable', reason: 'partition site column was not text' }
  }
  const topLevelSite = normalizeCookiePartitionSite(rawSite)
  if (!topLevelSite) {
    return { status: 'unreadable', reason: 'partition site column was not a valid schemeful site' }
  }

  if (!sourceColumns.has(CHROMIUM_CROSS_SITE_ANCESTOR_COLUMN)) {
    return {
      status: 'unreadable',
      reason: 'source schema has no cross-site-ancestor column for a partitioned cookie'
    }
  }
  const hasCrossSiteAncestor = readSqliteFlag(sourceRow[CHROMIUM_CROSS_SITE_ANCESTOR_COLUMN])
  if (hasCrossSiteAncestor === null) {
    return { status: 'unreadable', reason: 'cross-site-ancestor column was not an integer flag' }
  }

  return { status: 'partitioned', partitionKey: { topLevelSite, hasCrossSiteAncestor } }
}

const FIREFOX_PARTITIONED_ATTRIBUTE_COLUMN = 'isPartitionedAttributeSet'

/**
 * Reads whether Firefox recorded the server-declared `Partitioned` attribute.
 *
 * `originAttributes.partitionKey` is Firefox storage isolation and may include port or ancestor
 * context. The separate `isPartitionedAttributeSet` column is the server-declared CHIPS signal.
 */
export function readFirefoxRowPartition(
  sourceRow: Record<string, unknown>,
  sourceColumns: ReadonlySet<string>
): SourcePartitionRead {
  if (!sourceColumns.has(FIREFOX_PARTITIONED_ATTRIBUTE_COLUMN)) {
    return UNPARTITIONED
  }
  const partitionedAttribute = readSqliteFlag(sourceRow[FIREFOX_PARTITIONED_ATTRIBUTE_COLUMN])
  if (partitionedAttribute === false) {
    return UNPARTITIONED
  }
  if (partitionedAttribute === null) {
    return { status: 'unreadable', reason: 'partitioned-attribute column was not an integer flag' }
  }
  return {
    status: 'unreadable',
    reason: 'Firefox partitioned-attribute cookie has no cross-site-ancestor bit to read'
  }
}

/**
 * Reads a JSON cookie entry's partition identity.
 *
 * Absent means unpartitioned — every mainstream exporter omits the field for ordinary cookies, so
 * treating absence as unreadable would reject whole exports. Present-but-incomplete is unreadable:
 * exporters that emit only `topLevelSite` (or the legacy CDP string form) carry no ancestor bit, and
 * guessing it silently misfiles the cookie.
 */
export function readJsonCookiePartition(
  raw: unknown,
  partitionKeyOpaque: unknown = undefined
): SourcePartitionRead {
  if (partitionKeyOpaque === true) {
    return { status: 'unreadable', reason: 'partition key was opaque' }
  }
  if (partitionKeyOpaque !== undefined && typeof partitionKeyOpaque !== 'boolean') {
    return { status: 'unreadable', reason: 'partitionKeyOpaque was not a boolean' }
  }
  if (raw === undefined) {
    return UNPARTITIONED
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { status: 'unreadable', reason: 'partitionKey was not an object with both fields' }
  }

  const { topLevelSite, hasCrossSiteAncestor } = raw as Record<string, unknown>
  if (typeof topLevelSite !== 'string' || topLevelSite.length === 0) {
    return { status: 'unreadable', reason: 'partitionKey.topLevelSite was missing or not text' }
  }
  const normalizedTopLevelSite = normalizeCookiePartitionSite(topLevelSite)
  if (!normalizedTopLevelSite) {
    return {
      status: 'unreadable',
      reason: 'partitionKey.topLevelSite was not a valid schemeful site'
    }
  }
  if (typeof hasCrossSiteAncestor !== 'boolean') {
    return {
      status: 'unreadable',
      reason: 'partitionKey.hasCrossSiteAncestor was missing or not a boolean'
    }
  }

  return {
    status: 'partitioned',
    partitionKey: { topLevelSite: normalizedTopLevelSite, hasCrossSiteAncestor }
  }
}
