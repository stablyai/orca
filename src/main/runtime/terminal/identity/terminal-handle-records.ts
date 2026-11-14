import type {
  RuntimePtyWorktreeRecord,
  RuntimeLeafRecord
} from '../records/runtime-terminal-state-records'
export type PtyIncarnationHandleRecord = Readonly<{
  handle: string
  incarnationId: string | null
  leafKey: string
}>

export type TerminalHandlePty = {
  record: TerminalHandleRecord
  pty: RuntimePtyWorktreeRecord
}

export type TerminalHandleLeaf = {
  record: TerminalHandleRecord
  leaf: RuntimeLeafRecord
}

export type TerminalHandleRecord = Readonly<{
  handle: string
  runtimeId: string
  rendererGraphEpoch: number
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string | null
  ptyGeneration: number
  /** Issue-time stamp of the pane main bound a terminal handle for; read only by recoverTerminalPane. */
  issuedForPaneKey?: string
}>
