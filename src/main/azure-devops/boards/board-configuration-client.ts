import type {
  AzureDevOpsBacklogColumnField,
  AzureDevOpsBacklogConfiguration,
  AzureDevOpsBacklogLevel,
  AzureDevOpsBoardCardField,
  AzureDevOpsBoardConfiguration,
  AzureDevOpsBoardSummary,
  AzureDevOpsBugsBehavior
} from '../../../shared/azure-devops/boards-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'

const DEFAULT_ROW_ID = '00000000-0000-0000-0000-000000000000'

type RawLevel = {
  id?: string
  name?: string
  rank?: number
  workItemTypes?: { name?: string }[]
  columnFields?: {
    columnFieldReference?: { referenceName?: string; name?: string }
    width?: number
  }[]
}
type RawBacklogConfiguration = {
  bugsBehavior?: string
  hiddenBacklogs?: string[]
  portfolioBacklogs?: RawLevel[]
  requirementBacklog?: RawLevel
  taskBacklog?: RawLevel
}

function mapLevel(
  raw: RawLevel,
  kind: AzureDevOpsBacklogLevel['kind'],
  hidden: Set<string>
): AzureDevOpsBacklogLevel | null {
  if (!raw.id || !raw.name) {
    return null
  }
  const columnFields: AzureDevOpsBacklogColumnField[] = []
  for (const field of raw.columnFields ?? []) {
    const referenceName = field.columnFieldReference?.referenceName
    if (referenceName) {
      columnFields.push({
        referenceName,
        name: field.columnFieldReference?.name ?? referenceName,
        width: typeof field.width === 'number' ? field.width : 100
      })
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    rank: typeof raw.rank === 'number' ? raw.rank : 0,
    kind,
    workItemTypes: (raw.workItemTypes ?? [])
      .map((t) => t.name)
      .filter((n): n is string => Boolean(n)),
    columnFields,
    hidden: hidden.has(raw.id)
  }
}

export async function getAzureDevOpsBacklogConfiguration(
  repo: AzureDevOpsRepoRef,
  teamName: string
): Promise<AzureDevOpsBacklogConfiguration | null> {
  const bases = resolveAzureDevOpsApiBases(repo)
  const raw = await requestAzureDevOpsJsonAtBase<RawBacklogConfiguration>(
    bases.team(teamName),
    '/_apis/work/backlogconfiguration'
  )
  if (!raw) {
    return null
  }
  const hidden = new Set(raw.hiddenBacklogs ?? [])
  const levels = [
    ...(raw.portfolioBacklogs ?? []).map((l) => mapLevel(l, 'portfolio', hidden)),
    raw.requirementBacklog ? mapLevel(raw.requirementBacklog, 'requirement', hidden) : null,
    raw.taskBacklog ? mapLevel(raw.taskBacklog, 'task', hidden) : null
  ].filter((l): l is AzureDevOpsBacklogLevel => l !== null)
  // Why: the API lists portfolio levels in ascending order; the picker shows top-down like ADO.
  levels.sort((a, b) => b.rank - a.rank)
  return { levels, bugsBehavior: normalizeBugsBehavior(raw.bugsBehavior) }
}

function normalizeBugsBehavior(value: unknown): AzureDevOpsBugsBehavior {
  return value === 'asTasks' || value === 'off' ? value : 'asRequirements'
}

export async function listAzureDevOpsBoards(
  repo: AzureDevOpsRepoRef,
  teamName: string
): Promise<AzureDevOpsBoardSummary[]> {
  const bases = resolveAzureDevOpsApiBases(repo)
  const raw = await requestAzureDevOpsJsonAtBase<{ value?: { id?: string; name?: string }[] }>(
    bases.team(teamName),
    '/_apis/work/boards'
  )
  return (raw?.value ?? []).filter((b): b is { id: string; name: string } =>
    Boolean(b.id && b.name)
  )
}

type RawColumn = {
  id?: string
  name?: string
  columnType?: string
  itemLimit?: number
  isSplit?: boolean | null
  stateMappings?: Record<string, string>
  description?: string | null
}
type RawBoard = {
  id?: string
  name?: string
  columns?: RawColumn[]
  fields?: {
    columnField?: { referenceName?: string }
    rowField?: { referenceName?: string }
    doneField?: { referenceName?: string }
  }
}
type RawRow = { id?: string; name?: string; color?: string | null }
type RawCardSetting = { displayType?: string; fieldIdentifier?: string; showEmptyFields?: string }
type RawCardRules = {
  rules?: {
    tagStyle?: { isEnabled?: string; name?: string; settings?: { 'background-color'?: string } }[]
  }
}

export async function getAzureDevOpsBoardConfiguration(
  repo: AzureDevOpsRepoRef,
  teamName: string,
  boardId: string
): Promise<AzureDevOpsBoardConfiguration | null> {
  const base = resolveAzureDevOpsApiBases(repo).team(teamName)
  const path = `/_apis/work/boards/${encodeURIComponent(boardId)}`
  const [board, rows, cards, rules] = await Promise.all([
    requestAzureDevOpsJsonAtBase<RawBoard>(base, path),
    requestAzureDevOpsJsonAtBase<{ value?: RawRow[] }>(base, `${path}/rows`),
    requestAzureDevOpsJsonAtBase<{ cards?: Record<string, RawCardSetting[]> }>(
      base,
      `${path}/cardsettings`
    ),
    requestAzureDevOpsJsonAtBase<RawCardRules>(base, `${path}/cardrulesettings`)
  ])
  if (!board?.id || !board.name) {
    return null
  }
  const columnField = board.fields?.columnField?.referenceName
  const rowField = board.fields?.rowField?.referenceName
  const doneField = board.fields?.doneField?.referenceName
  if (!columnField || !rowField || !doneField) {
    return null
  }
  const cardFields: AzureDevOpsBoardConfiguration['cardFields'] = {}
  for (const [workItemType, settings] of Object.entries(cards?.cards ?? {})) {
    const fields: AzureDevOpsBoardCardField[] = []
    let showEmptyFields = false
    for (const setting of settings) {
      if (setting.showEmptyFields !== undefined) {
        showEmptyFields = setting.showEmptyFields === 'true'
      } else if (setting.fieldIdentifier) {
        fields.push({
          referenceName: setting.fieldIdentifier,
          core: setting.displayType === 'CORE'
        })
      }
    }
    cardFields[workItemType] = { fields, showEmptyFields }
  }
  const tagColors: Record<string, string> = {}
  for (const rule of rules?.rules?.tagStyle ?? []) {
    const color = rule.settings?.['background-color']
    if (rule.isEnabled === 'True' && rule.name && color) {
      tagColors[rule.name] = color
    }
  }
  return {
    id: board.id,
    name: board.name,
    columns: (board.columns ?? [])
      .filter((c): c is RawColumn & { id: string; name: string } => Boolean(c.id && c.name))
      .map((c) => ({
        id: c.id,
        name: c.name,
        columnType:
          c.columnType === 'incoming' || c.columnType === 'outgoing' ? c.columnType : 'inProgress',
        itemLimit: typeof c.itemLimit === 'number' ? c.itemLimit : 0,
        isSplit: c.isSplit === true,
        stateMappings: c.stateMappings ?? {},
        description: c.description ?? null
      })),
    // Why: colours only come back from /rows; the board payload embeds rows with color: null.
    rows: (rows?.value ?? [])
      .filter((r): r is RawRow & { id: string } => Boolean(r.id))
      .map((r) => ({
        id: r.id,
        name: r.name ?? '',
        color: r.color ?? null,
        isDefault: r.id === DEFAULT_ROW_ID
      })),
    columnField,
    rowField,
    doneField,
    cardFields,
    tagColors
  }
}
