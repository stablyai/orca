import { isBrowserExtensionSupportEnabled } from '../browser-extension-support'

export type BrowserExtensionProfileDemandOwner = {
  readonly ready: Promise<void>
  release: () => Promise<void>
  changed: Set<() => void>
}
/** `revoke` settles a replacement gate that leaves the active set before its producer does. */
type Target = { ready: Promise<void>; failed: boolean; revoke?: () => void }
type ProfileDemand = {
  pages: Set<object>
  targets: Map<string, Set<object>>
  active: Map<string, Target>
  ready: Promise<void>
  changed: Set<() => void>
  enabled: () => string[]
  activate: (extensionId: string, page: boolean) => Promise<void>
  suspend: (extensionId: string) => Promise<void>
  activating?: (ready: Promise<void>) => void
}
const profiles = new Map<string, ProfileDemand>()

export function attachBrowserExtensionProfileDemand(
  profileId: string,
  activate: ProfileDemand['activate'],
  suspend: ProfileDemand['suspend'],
  enabled: () => string[],
  activating?: ProfileDemand['activating']
): void {
  profiles.set(profileId, {
    pages: new Set(),
    targets: new Map(),
    active: new Map(),
    ready: Promise.resolve(),
    changed: new Set(),
    activate,
    suspend,
    enabled,
    activating
  })
}

export function detachBrowserExtensionProfileDemand(profileId: string): void {
  const demand = profiles.get(profileId)
  profiles.delete(profileId)
  if (demand) {
    for (const id of demand.active.keys()) {
      deleteTarget(demand, id)
    }
  }
}

function deleteTarget(demand: ProfileDemand, extensionId: string): void {
  const target = demand.active.get(extensionId)
  demand.active.delete(extensionId)
  target?.revoke?.()
}

function setTarget(demand: ProfileDemand, extensionId: string, target: Target): void {
  const previous = demand.active.get(extensionId)
  demand.active.set(extensionId, target)
  if (previous !== target) {
    previous?.revoke?.()
  }
}

function publish(demand: ProfileDemand): void {
  // Terminal failures are recorded by their load; healthy targets still establish page readiness.
  demand.ready = Promise.allSettled([...demand.active.values()].map((target) => target.ready)).then(
    () => undefined
  )
  demand.activating?.(demand.ready)
  for (const listener of demand.changed) {
    listener()
  }
}

function isDesired(demand: ProfileDemand, extensionId: string): boolean {
  return (
    demand.targets.has(extensionId) ||
    (demand.pages.size > 0 && demand.enabled().includes(extensionId))
  )
}

export function hasBrowserExtensionProfileDemand(profileId: string): boolean {
  const demand = profiles.get(profileId)
  return Boolean(demand && (demand.pages.size > 0 || demand.targets.size > 0))
}

function reconcile(demand: ProfileDemand): Promise<void> {
  const desired = new Set([
    ...demand.targets.keys(),
    ...(demand.pages.size > 0 ? demand.enabled() : [])
  ])
  const retiring: Promise<void>[] = []
  let changed = false
  for (const id of demand.active.keys()) {
    if (!desired.has(id)) {
      deleteTarget(demand, id)
      retiring.push(demand.suspend(id))
      changed = true
    }
  }
  for (const id of desired) {
    if (!demand.active.has(id)) {
      const target = { ready: demand.activate(id, demand.pages.size > 0), failed: false }
      void target.ready.catch(() => {
        target.failed = true
      })
      setTarget(demand, id, target)
      changed = true
    }
  }
  if (changed) {
    publish(demand)
  }
  return Promise.all(retiring).then(() => undefined)
}

/** A missing target denotes an actual page, never a page-less explicit operation. */
export function acquireBrowserExtensionProfileDemand(
  profileId: string,
  extensionId?: string
): BrowserExtensionProfileDemandOwner | null {
  const demand = isBrowserExtensionSupportEnabled() && profiles.get(profileId)
  if (!demand) {
    return null
  }
  const owner = {}
  let owners = demand.pages
  if (extensionId !== undefined) {
    if (demand.active.get(extensionId)?.failed && !demand.targets.has(extensionId)) {
      deleteTarget(demand, extensionId)
    }
    owners = demand.targets.get(extensionId) ?? new Set()
    demand.targets.set(extensionId, owners)
  }
  owners.add(owner)
  void reconcile(demand).catch((error: unknown) =>
    console.warn('[browser-extensions] Could not suspend extensions:', error)
  )
  return {
    get ready() {
      return extensionId === undefined
        ? demand.ready
        : (demand.active.get(extensionId)?.ready ?? Promise.resolve())
    },
    changed: demand.changed,
    release: () => {
      if (!owners.delete(owner) || profiles.get(profileId) !== demand) {
        return Promise.resolve()
      }
      if (extensionId !== undefined && owners.size === 0) {
        demand.targets.delete(extensionId)
      }
      return reconcile(demand)
    }
  }
}

export function hasBrowserExtensionProfilePage(profileId: string): boolean {
  return (profiles.get(profileId)?.pages.size ?? 0) > 0
}

/** Explicit unload invalidates the attempt, except the replacement its own caller admitted. */
export function forgetBrowserExtensionTargetDemand(
  profileId: string,
  extensionId: string,
  replacement?: BrowserExtensionTargetReplacement
): void {
  const demand = profiles.get(profileId)
  if (!demand?.active.has(extensionId) || replacement?.current) {
    return
  }
  deleteTarget(demand, extensionId)
  publish(demand)
}

export type BrowserExtensionTargetReplacement = {
  readonly current: boolean
  /** Settles the published prerequisite with the replacement's actual tracked load. */
  settle: <T>(work: Promise<T>) => Promise<T>
  revoke: () => void
}

/**
 * Publishes one target prerequisite before its predecessor is cancelled, so a staged first
 * document waits for the replacement rather than the cancelled load; its producer never waits on
 * it. A reload covers only a demanded target; an explicit operation also holds its demand.
 */
export function admitBrowserExtensionTargetReplacement(
  profileId: string,
  extensionId: string,
  explicit: boolean
): BrowserExtensionTargetReplacement | null {
  const demand = isBrowserExtensionSupportEnabled() && profiles.get(profileId)
  if (!demand || (!explicit && !isDesired(demand, extensionId))) {
    return null
  }
  let resolveGate!: () => void
  let rejectGate!: (error: unknown) => void
  const target: Target = {
    ready: new Promise<void>((resolve, reject) => {
      resolveGate = resolve
      rejectGate = reject
    }),
    failed: false
  }
  void target.ready.catch(() => {
    target.failed = true
  })
  let revoked = false
  let settled = false
  let owner: BrowserExtensionProfileDemandOwner | null = null
  const release = (): void => {
    const held = owner
    owner = null
    void held
      ?.release()
      .catch((error: unknown) =>
        console.warn('[browser-extensions] Could not suspend extensions:', error)
      )
  }
  target.revoke = () => {
    if (!revoked) {
      revoked = true
      rejectGate(new Error('The extension was turned off before it finished loading'))
      release()
      // Why: no load ran to record a failure, so the next page must activate it again. A finished
      // replacement or a successor that took the entry stays.
      if (
        !settled &&
        profiles.get(profileId) === demand &&
        demand.active.get(extensionId) === target
      ) {
        demand.active.delete(extensionId)
        publish(demand)
      }
    }
  }
  setTarget(demand, extensionId, target)
  publish(demand)
  if (explicit) {
    owner = acquireBrowserExtensionProfileDemand(profileId, extensionId)
  }
  return {
    get current() {
      return (
        !revoked && profiles.get(profileId) === demand && demand.active.get(extensionId) === target
      )
    },
    settle: (work) => {
      void work.then(
        () => {
          settled = true
          resolveGate()
          release()
        },
        (error: unknown) => {
          settled = true
          rejectGate(error)
          release()
        }
      )
      return work
    },
    revoke: target.revoke
  }
}

/** Explicit installs/reloads publish their actual tracked prerequisite to pages using the same target. */
export function trackBrowserExtensionTargetReadiness(
  profileId: string,
  extensionId: string,
  ready: Promise<unknown>
): void {
  const demand = profiles.get(profileId)
  if (!demand) {
    return
  }
  const target = { ready: ready.then(() => undefined), failed: false }
  void target.ready.catch(() => {
    target.failed = true
  })
  setTarget(demand, extensionId, target)
  publish(demand)
}

export {
  retainBrowserExtensionPage,
  onBrowserExtensionPageReadiness,
  refreshBrowserExtensionPageDemand,
  onBrowserExtensionPageRetained
} from './browser-extension-page-demand'
