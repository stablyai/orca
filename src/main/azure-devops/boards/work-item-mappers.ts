import type {
  AzureDevOpsIdentityRef,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'

export type RawRelation = { rel?: string; url?: string; attributes?: Record<string, unknown> }
export type RawAzureDevOpsWorkItem = {
  id?: number
  rev?: number
  fields?: Record<string, unknown>
  relations?: RawRelation[]
}

export const BASE_WORK_ITEM_FIELDS: readonly string[] = [
  'System.Id',
  'System.Rev',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.AssignedTo',
  'System.AreaPath',
  'System.IterationPath',
  'System.Tags',
  'System.Parent',
  'Microsoft.VSTS.Common.StackRank'
]

function stringField(fields: Record<string, unknown>, name: string): string {
  const value = fields[name]
  return typeof value === 'string' ? value : ''
}

export function mapAzureDevOpsIdentity(value: unknown): AzureDevOpsIdentityRef | null {
  if (!value || typeof value !== 'object' || !('displayName' in value)) {
    return null
  }
  const raw: { displayName?: unknown; uniqueName?: unknown; imageUrl?: unknown } = value
  if (typeof raw.displayName !== 'string' || !raw.displayName) {
    return null
  }
  return {
    displayName: raw.displayName,
    uniqueName: typeof raw.uniqueName === 'string' ? raw.uniqueName : null,
    imageUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : null
  }
}

export function parseAzureDevOpsTags(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(';')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : []
}

export function mapAzureDevOpsWorkItem(
  raw: RawAzureDevOpsWorkItem,
  webUrl: (id: number) => string
): AzureDevOpsWorkItem | null {
  const fields = raw.fields ?? {}
  const workItemType = stringField(fields, 'System.WorkItemType')
  if (typeof raw.id !== 'number' || !workItemType) {
    return null
  }
  const parent = fields['System.Parent']
  const stackRank = fields['Microsoft.VSTS.Common.StackRank']
  return {
    id: raw.id,
    rev: typeof raw.rev === 'number' ? raw.rev : 0,
    workItemType,
    title: stringField(fields, 'System.Title'),
    state: stringField(fields, 'System.State'),
    assignedTo: mapAzureDevOpsIdentity(fields['System.AssignedTo']),
    areaPath: stringField(fields, 'System.AreaPath'),
    iterationPath: stringField(fields, 'System.IterationPath'),
    tags: parseAzureDevOpsTags(fields['System.Tags']),
    parentId: typeof parent === 'number' ? parent : null,
    stackRank: typeof stackRank === 'number' ? stackRank : null,
    url: webUrl(raw.id),
    fields
  }
}
