import type {
  AzureDevOpsBacklogColumnField,
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogSavedFilter,
  AzureDevOpsBacklogViewSettings
} from '../../../shared/azure-devops/boards-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'

// Why: per-user settings live at the collection root, not under the project/team path.
const SETTINGS_API_VERSION = '7.1-preview.1'
const COLUMN_OPTIONS_PREFIX = 'ColumnOptions/'
// Why: the requirement level keeps a legacy key instead of its category id.
const LEGACY_REQUIREMENT_COLUMN_KEY = 'ProductBacklogColumnOptions'
const FILTER_KEY_SUFFIX = '/Filter'

type RawEntries = { count?: number; value?: Record<string, unknown> }
type RawColumnOption = {
  name?: unknown
  text?: unknown
  width?: unknown
  rollup?: unknown
}
type RawFilterValue = { value?: { key?: unknown; value?: unknown; display?: unknown }[] }

function parseJsonString<T>(value: unknown): T | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller-supplied T is the shape it validates field-by-field before use; a mismatch degrades to nulls, never a throw.
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

/** Both the current and the legacy (`id`/`fieldType`) shapes normalise on `name`; rollups are dropped. */
export function parseAzureDevOpsColumnOptions(value: unknown): AzureDevOpsBacklogColumnField[] {
  const parsed = parseJsonString<RawColumnOption[]>(value)
  if (!Array.isArray(parsed)) {
    return []
  }
  const columns: AzureDevOpsBacklogColumnField[] = []
  for (const option of parsed) {
    if (!option || typeof option.name !== 'string' || !option.name || option.rollup === true) {
      continue
    }
    columns.push({
      referenceName: option.name,
      name: typeof option.text === 'string' && option.text ? option.text : option.name,
      width: typeof option.width === 'number' && option.width > 0 ? option.width : 100
    })
  }
  return columns
}

function filterValues(raw: RawFilterValue | undefined): string[] {
  return (raw?.value ?? [])
    .map((entry) =>
      typeof entry.value === 'string'
        ? entry.value
        : typeof entry.display === 'string'
          ? entry.display
          : typeof entry.key === 'string'
            ? entry.key
            : null
    )
    .filter((v): v is string => v !== null && v.length > 0)
}

export function parseAzureDevOpsSavedFilter(value: unknown): AzureDevOpsBacklogSavedFilter | null {
  const parsed = parseJsonString<Record<string, RawFilterValue> & { text?: unknown }>(value)
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const text = parsed.text
  const keyword =
    typeof text === 'string'
      ? text
      : text && typeof text === 'object'
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `text` is a non-null object here and filterValues reads only optional keys off it, tolerating any shape.
          filterValues(text as RawFilterValue)[0]
        : null
  return {
    keyword: keyword ?? null,
    workItemTypes: filterValues(parsed['System.WorkItemType']),
    assignedTo: filterValues(parsed['System.AssignedTo']),
    states: filterValues(parsed['System.State']),
    areaPaths: filterValues(parsed['System.AreaPath']),
    iterationPaths: filterValues(parsed['System.IterationPath']),
    tags: filterValues(parsed['System.Tags'])
  }
}

function booleanEntry(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }
  return value === 'true' ? true : value === 'false' ? false : null
}

export function mapAzureDevOpsBacklogViewSettings(
  hub: Record<string, unknown>,
  filters: Record<string, unknown>,
  levels: AzureDevOpsBacklogLevel[]
): AzureDevOpsBacklogViewSettings {
  const requirementId = levels.find((l) => l.kind === 'requirement')?.id ?? null
  const columnOptionsByLevel: Record<string, AzureDevOpsBacklogColumnField[]> = {}
  for (const [key, value] of Object.entries(hub)) {
    if (!key.startsWith(COLUMN_OPTIONS_PREFIX)) {
      continue
    }
    const suffix = key.slice(COLUMN_OPTIONS_PREFIX.length)
    const levelId = suffix === LEGACY_REQUIREMENT_COLUMN_KEY ? requirementId : suffix
    const columns = parseAzureDevOpsColumnOptions(value)
    if (levelId && columns.length > 0) {
      columnOptionsByLevel[levelId] = columns
    }
  }
  const savedFiltersByLevel: Record<string, AzureDevOpsBacklogSavedFilter> = {}
  for (const [key, value] of Object.entries(filters)) {
    if (!key.endsWith(FILTER_KEY_SUFFIX)) {
      continue
    }
    const levelName = key.slice(0, -FILTER_KEY_SUFFIX.length)
    const level = levels.find((l) => l.name === levelName)
    const filter = level ? parseAzureDevOpsSavedFilter(value) : null
    if (level && filter) {
      savedFiltersByLevel[level.id] = filter
    }
  }
  return {
    columnOptionsByLevel,
    showParents: booleanEntry(hub.ShowParentsFilter),
    inProgressFilter: booleanEntry(hub.InProgressFilter),
    savedFiltersByLevel
  }
}

let warnedOnce = false

/**
 * The signed-in user's Backlogs hub settings for `teamId`. Null when the call is
 * unauthorised or the host has no such endpoint; callers fall back to process
 * defaults and never block the view on it.
 */
export async function getAzureDevOpsBacklogViewSettings(
  repo: AzureDevOpsRepoRef,
  teamId: string,
  levels: AzureDevOpsBacklogLevel[]
): Promise<AzureDevOpsBacklogViewSettings | null> {
  const bases = resolveAzureDevOpsApiBases(repo)
  const entries = `/_apis/Settings/WebTeam/${encodeURIComponent(teamId)}/Entries/me`
  const options = { searchParams: { 'api-version': SETTINGS_API_VERSION } }
  const [hub, filters] = await Promise.all([
    requestAzureDevOpsJsonAtBase<RawEntries>(
      bases.collection,
      `${entries}/Agile/BacklogsHub`,
      options
    ),
    requestAzureDevOpsJsonAtBase<RawEntries>(
      bases.collection,
      `${entries}/Backlogs/backlog`,
      options
    )
  ])
  if (!hub) {
    if (!warnedOnce) {
      warnedOnce = true
      console.warn(
        '[azure-devops] per-user backlog view settings unavailable; using process defaults'
      )
    }
    return null
  }
  return mapAzureDevOpsBacklogViewSettings(hub.value ?? {}, filters?.value ?? {}, levels)
}
