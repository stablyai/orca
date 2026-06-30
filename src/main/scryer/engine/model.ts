export const SCRY_VERSION = '0.3' as const

export type ScryKind = 'person' | 'system' | 'container' | 'component' | 'symbol'

export type ScryResponsibility = {
  id: string
  statement: string
  vagrant?: boolean
  stale?: boolean
  staleProposal?: string
  directives?: string[]
  lastTouchedAt?: number
}

export type ScrySchemaProperty = {
  label: string
  description?: string
  vagrant?: boolean
  stale?: boolean
  lastTouchedAt?: number
}

export type ScrySource = {
  pattern: string
  comment?: string
}

export type ScrySourceLocation = {
  pattern: string
  symbol?: string
  line?: number
  endLine?: number
  command?: string
}

export type ScryRenderState = 'proposed' | 'implemented' | 'changed'

export type ScryAppearance = {
  status?: ScryRenderState
  distPath?: string
  builtAt?: number
  sourceHash?: string
  [key: string]: unknown
}

export type ScryNode = {
  id: string
  kind: ScryKind
  name: string
  parentId?: string
  external?: boolean
  technology?: string
  description?: string
  vagrant?: boolean
  stale?: boolean
  responsibilities?: ScryResponsibility[]
  properties?: ScrySchemaProperty[]
  icon?: string
  visual?: boolean
  appearance?: ScryAppearance
  notes?: string
}

export type ScryLink = {
  id: string
  src: string
  dst: string
  label: string
  method?: string
}

export type ScryGroup = {
  id: string
  name: string
  description?: string
  memberIds: string[]
  parentGroupId?: string
  parentNodeId?: string | null
  responsibilities?: ScryResponsibility[]
  icon?: string
}

export type ScryModel = {
  version: typeof SCRY_VERSION
  nodes: ScryNode[]
  links: ScryLink[]
  groups: ScryGroup[]
  sourceMap: Record<string, ScrySourceLocation[]>
  boundaries: Record<string, ScrySource[]>
}

export function emptyScryModel(): ScryModel {
  return {
    version: SCRY_VERSION,
    nodes: [],
    links: [],
    groups: [],
    sourceMap: {},
    boundaries: {}
  }
}
