export type RunCompletionWaiver = {
  task_id: string
  reason: string
}

export type RunCompletion = {
  run_id: string
  summary: string
  evidence: string[]
  waivers: RunCompletionWaiver[]
  completed_by_handle: string
  completed_by_generation: number
  completed_at: string
}
