import AsyncStorage from '@react-native-async-storage/async-storage'

export const RECENT_WORKSPACES_STORAGE_KEY = 'orca:recent-workspaces'
export const RECENT_WORKSPACES_LIMIT = 12

export type RecentWorkspace = {
  hostId: string
  worktreeId: string
  name: string
  openedAt: number
}

function isRecentWorkspace(value: unknown): value is RecentWorkspace {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record: Record<string, unknown> = { ...value }
  return (
    typeof record.hostId === 'string' &&
    record.hostId !== '' &&
    typeof record.worktreeId === 'string' &&
    record.worktreeId !== '' &&
    typeof record.name === 'string' &&
    typeof record.openedAt === 'number'
  )
}

export function parseRecentWorkspaces(raw: string | null): RecentWorkspace[] {
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isRecentWorkspace) : []
  } catch {
    return []
  }
}

export function isSameWorkspace(
  a: Pick<RecentWorkspace, 'hostId' | 'worktreeId'>,
  b: Pick<RecentWorkspace, 'hostId' | 'worktreeId'>
): boolean {
  return a.hostId === b.hostId && a.worktreeId === b.worktreeId
}

/** Most-recent first, one entry per workspace, capped. A blank name keeps the last known one. */
export function upsertRecentWorkspace(
  list: readonly RecentWorkspace[],
  entry: RecentWorkspace
): RecentWorkspace[] {
  const previous = list.find((item) => isSameWorkspace(item, entry))
  const name = entry.name || previous?.name || ''
  return [{ ...entry, name }, ...list.filter((item) => !isSameWorkspace(item, entry))].slice(
    0,
    RECENT_WORKSPACES_LIMIT
  )
}

let cache: RecentWorkspace[] | null = null
let loading: Promise<RecentWorkspace[]> | null = null
const listeners = new Set<(list: RecentWorkspace[]) => void>()

function publish(list: RecentWorkspace[]): void {
  cache = list
  for (const listener of listeners) {
    listener(list)
  }
}

export function loadRecentWorkspaces(): Promise<RecentWorkspace[]> {
  if (cache) {
    return Promise.resolve(cache)
  }
  loading ??= AsyncStorage.getItem(RECENT_WORKSPACES_STORAGE_KEY)
    .then(parseRecentWorkspaces)
    .catch(() => [])
    .then((list) => {
      // Why: a record written while the read was open is newer than the stored list.
      if (!cache) {
        cache = list
      }
      return cache
    })
  return loading
}

export function subscribeRecentWorkspaces(listener: (list: RecentWorkspace[]) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Why: each record reads the list its predecessor wrote, so two records issued together both land.
let recording: Promise<void> = Promise.resolve()

export function recordRecentWorkspace(entry: RecentWorkspace): Promise<void> {
  const run = recording.then(async () => {
    const next = upsertRecentWorkspace(await loadRecentWorkspaces(), entry)
    publish(next)
    await AsyncStorage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(next)).catch(() => {})
  })
  // Why: one failed record (e.g. a throwing listener) must not skip every record queued after it.
  recording = run.catch(() => {})
  return run
}

export function resetRecentWorkspacesForTest(): void {
  cache = null
  loading = null
  recording = Promise.resolve()
  listeners.clear()
}
