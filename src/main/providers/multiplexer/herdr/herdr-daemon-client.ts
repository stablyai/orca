export type HerdrPaneIdentity = {
  version: number
  projectId: string
  workspaceId: string
  tabId: string
  leafId: string
  paneId: string
}

export type HerdrPaneTarget = {
  project: string
  workspace: string
  tab: string
  leaf: string
}

export type HerdrPaneOptions = {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  command?: string
  launchAgent?: string
}

export type HerdrPaneResult = {
  paneId: string
  identity: HerdrPaneIdentity
  isReattach: boolean
  snapshot?: string
  snapshotCols?: number
  snapshotRows?: number
}

export type HerdrSessionSnapshot = {
  data: string
  frame: { width: number; height: number }
}

export type HerdrBufferSnapshot = {
  data: string
  cols: number
  rows: number
  scrollbackAnsi?: string
  seq: number
  source: 'headless'
  oscLinks?: unknown[]
  alternateScreen?: boolean
  pendingEscapeTailAnsi?: string
}

export type HerdrSshConnectResult = {
  success: boolean
  connectionId: string
}

export type HerdrRemoteAttachResult = {
  success: boolean
  paneId: string
}

export type HerdrPaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type HerdrAgentInfo = {
  agent: string | null
  agent_status: HerdrPaneStatus
  display_agent?: string | null
  cwd?: string | null
  focused?: boolean
}

export type HerdrSessionListResult = {
  sessions: {
    sessionName: string
    projectId: string
    workspaceId: string
    panes: {
      paneId: string
      leafId: string
      title?: string
      agent?: HerdrAgentInfo
    }[]
  }[]
}
