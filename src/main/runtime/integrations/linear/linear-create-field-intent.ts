export type LinearCreateFieldIntent = {
  stateId?: string
  assigneeId?: string | null
  priority?: number
  estimate?: number | null
  dueDate?: string | null
  labelIds?: string[]
  projectId?: string
}
