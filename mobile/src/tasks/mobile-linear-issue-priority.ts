const LINEAR_PRIORITY_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

export function getLinearPriorityLabel(priority: number): string {
  return LINEAR_PRIORITY_LABELS[priority] ?? `P${priority}`
}

// Linear encodes "no priority" as 0 but sorts it last, so rank it below Low.
export function getLinearPriorityRank(priority: number): number {
  return priority === 0 ? 5 : priority
}
