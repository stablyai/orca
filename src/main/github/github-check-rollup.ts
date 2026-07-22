import type { GitHubPRCheckSummary } from '../../shared/types'

type CheckContextKind = 'CheckRun' | 'StatusContext'

type SelectedContext<T> = {
  entry: T
  index: number
  timestamp: number | null
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nestedRecord(
  value: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  return recordFromUnknown(value?.[key])
}

function checkContextKind(entry: Record<string, unknown>): CheckContextKind | null {
  if (entry.__typename === 'CheckRun') {
    return 'CheckRun'
  }
  if (entry.__typename === 'StatusContext') {
    return 'StatusContext'
  }
  if (stringFromUnknown(entry.name)) {
    return 'CheckRun'
  }
  if (stringFromUnknown(entry.context)) {
    return 'StatusContext'
  }
  return null
}

function checkRunIdentity(entry: Record<string, unknown>): string | null {
  const name = stringFromUnknown(entry.name)
  if (!name) {
    return null
  }
  const checkSuite = nestedRecord(entry, 'checkSuite')
  const workflowRun = nestedRecord(checkSuite, 'workflowRun')
  const app = nestedRecord(checkSuite, 'app') ?? nestedRecord(entry, 'app')
  const workflow = nestedRecord(workflowRun, 'workflow')
  const appSlug = stringFromUnknown(app?.slug)
  const workflowName = stringFromUnknown(entry.workflowName) ?? stringFromUnknown(workflow?.name)
  const provider = appSlug ? `app:${appSlug}` : workflowName ? `workflow:${workflowName}` : null
  return JSON.stringify(['CheckRun', name, provider])
}

function checkContextIdentity(entry: Record<string, unknown>): string | null {
  const kind = checkContextKind(entry)
  if (kind === 'CheckRun') {
    return checkRunIdentity(entry)
  }
  if (kind === 'StatusContext') {
    const context = stringFromUnknown(entry.context)
    return context ? JSON.stringify(['StatusContext', context]) : null
  }
  return null
}

function timestampFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return null
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function checkContextTimestamp(entry: Record<string, unknown>): number | null {
  const kind = checkContextKind(entry)
  // 原因：运行开始时间能区分同名重跑且不受完成时刻变化影响；旧式状态则以创建时间排序。
  const candidates =
    kind === 'CheckRun'
      ? [entry.startedAt, entry.createdAt, entry.completedAt]
      : [entry.createdAt, entry.startedAt, entry.updatedAt]
  for (const candidate of candidates) {
    const timestamp = timestampFromUnknown(candidate)
    if (timestamp !== null) {
      return timestamp
    }
  }
  return null
}

function shouldReplace<T>(current: SelectedContext<T>, candidate: SelectedContext<T>): boolean {
  // 原因：GitHub 会省略或复用时间戳；并列时以后返回的条目为准，避免保留旧失败结果。
  if (candidate.timestamp === null) {
    return current.timestamp === null
  }
  return current.timestamp === null || candidate.timestamp >= current.timestamp
}

export function selectLatestGitHubCheckContexts<T>(entries: readonly T[]): T[] {
  const selectedByIdentity = new Map<string, SelectedContext<T>>()
  const ungrouped: SelectedContext<T>[] = []

  entries.forEach((entry, index) => {
    const record = recordFromUnknown(entry)
    const identity = record ? checkContextIdentity(record) : null
    const candidate = {
      entry,
      index,
      timestamp: record ? checkContextTimestamp(record) : null
    }
    if (!identity) {
      ungrouped.push(candidate)
      return
    }
    const current = selectedByIdentity.get(identity)
    if (!current || shouldReplace(current, candidate)) {
      selectedByIdentity.set(identity, candidate)
    }
  })

  return [...ungrouped, ...selectedByIdentity.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ entry }) => entry)
}

function checkRollupEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  const raw = recordFromUnknown(value)
  const nodes = nestedRecord(raw, 'contexts')?.nodes
  return Array.isArray(nodes) ? nodes : []
}

export function deriveGitHubCheckSummary(value: unknown): GitHubPRCheckSummary {
  const entries = selectLatestGitHubCheckContexts(checkRollupEntries(value))
  if (entries.length === 0) {
    return { state: 'none', total: 0, passed: 0, failed: 0, pending: 0 }
  }

  let passed = 0
  let failed = 0
  let pending = 0
  for (const entry of entries) {
    const raw = recordFromUnknown(entry)
    if (!raw) {
      pending += 1
      continue
    }
    const conclusion = String(raw.conclusion ?? raw.state ?? '').toUpperCase()
    const status = String(raw.status ?? '').toUpperCase()
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) {
      passed += 1
    } else if (
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
        conclusion
      )
    ) {
      failed += 1
    } else if (status === 'COMPLETED' && conclusion) {
      // 原因：GitHub 新增的完成结论不能被误报为成功或仍在运行，未知值保守按失败展示。
      failed += 1
    } else {
      pending += 1
    }
  }

  return {
    state: failed > 0 ? 'failure' : pending > 0 ? 'pending' : 'success',
    total: entries.length,
    passed,
    failed,
    pending
  }
}
