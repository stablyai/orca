export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'

export type TaskRow = {
  id: string
  run_id: string
  parent_id: string | null
  created_by_terminal_handle: string | null
  created_by_pane_key: string | null
  created_by_process_incarnation: string | null
  created_by_run_generation: number | null
  task_title: string | null
  display_name: string | null
  model: string | null
  effort: string | null
  spec: string
  status: TaskStatus
  deps: string
  result: string | null
  created_at: string
  completed_at: string | null
}
