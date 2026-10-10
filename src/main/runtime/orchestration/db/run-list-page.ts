import type { RunRow, TaskRow } from '../types'

export type RunListPage = {
  runs: RunRow[]
  nextCursor: string | null
}

export type TaskRuntimeLineageRow = TaskRow & {
  creator_dispatch_id: string | null
  creator_dispatch_run_id: string | null
  creator_dispatch_pane_key: string | null
  creator_dispatch_process_incarnation: string | null
}

export type RunListCursor = {
  createdAt: string
  id: string
}
