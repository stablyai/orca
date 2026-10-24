export type MobileChatDraftStorage = {
  read(key: string): Promise<string | null>
  write(key: string, value: string | null): Promise<void>
  removeWorkspace(hostId: string, workspaceId?: string): Promise<void>
  dispose?(): void
}
let storage: MobileChatDraftStorage | null = null
type PrepareRemoval = (host: string, workspace?: string) => () => Promise<void>
type Removal = { host: string; workspace?: string; run: () => Promise<void>; work?: Promise<void> }
const pendingRemovals = new Map<string, Removal>()
let prepareRemoval: PrepareRemoval = () => async () => {}

/** Native startup and the downloaded page supply their own acknowledged storage adapters. */
export function publishMobileChatDraftStorage(
  next: MobileChatDraftStorage | null,
  prepare: PrepareRemoval = (host, workspace) => () =>
    next?.removeWorkspace(host, workspace) ?? Promise.resolve()
): void {
  if (storage === next) {
    return
  }
  storage?.dispose?.()
  storage = next
  prepareRemoval = prepare
  listeners.forEach((listener) => listener())
}
export function mobileChatDraftStorage(): MobileChatDraftStorage | null {
  return storage
}

const listeners = new Set<() => void>()
export function subscribeMobileChatDraftStorage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const removals = new Set<(host: string, workspace?: string) => void>()
export function onMobileChatDraftRemoval(
  listener: (host: string, workspace?: string) => void
): () => void {
  removals.add(listener)
  return () => {
    removals.delete(listener)
  }
}
export function retireMobileChatDraftScopes(host: string, workspace?: string): void {
  removals.forEach((listener) => listener(host, workspace))
}

export function mobileChatDraftRemoving(scope: string): boolean {
  const [host, workspace] = scope.split('\0')
  return [...pendingRemovals.values()].some(
    (entry) =>
      entry.host === host && (entry.workspace === undefined || entry.workspace === workspace)
  )
}
export function removeMobileChatDraftScopes(
  host: string,
  workspace?: string,
  prepare = prepareRemoval
): Promise<void> {
  const key = `${host}\0${workspace ?? ''}`
  let held = pendingRemovals.get(key)
  if (held?.work) {
    return held.work
  }
  if (!held) {
    held = { host, workspace, run: prepare(host, workspace) }
    pendingRemovals.set(key, held)
    retireMobileChatDraftScopes(host, workspace)
  }
  const removal = held
  const work = Promise.resolve()
    .then(removal.run)
    .then(() => {
      pendingRemovals.delete(key)
    })
    .finally(() => {
      removal.work = undefined
    })
  removal.work = work
  return work
}
export function retryMobileChatDraftRemovals(): void {
  for (const removal of pendingRemovals.values()) {
    if (!removal.work) {
      void removeMobileChatDraftScopes(removal.host, removal.workspace).catch(() => undefined)
    }
  }
}
