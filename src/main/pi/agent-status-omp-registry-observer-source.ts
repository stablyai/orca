import { getOmpRootStatusSourceLines } from './agent-status-omp-root-status-source'

// Factory scope: these functions reuse the existing roster, delivery queue and
// completion gate. A child factory must never acquire or retire the root binding.
export function getOmpRegistryObserverSourceLines(): string[] {
  return [
    ...String.raw`
  const ompRegistryOwner = {}
  const OMP_REGISTRY_COALESCE_MS = 200
  const OMP_REGISTRY_REFRESH_MS = 5000

  function currentOmpRegistryObservation(observation: OmpRegistryObservation): boolean {
    return !observation.stopped && observation.owner === ompRegistryOwner && lifecycleState.ompRegistryObserver === observation && ompRegistryObservation === observation
  }

  function stopOmpRegistryObserver(): void {
    if (!isOmpRuntime()) return
    const observation = lifecycleState.ompRegistryObserver
    if (observation?.owner === ompRegistryOwner) retireOmpRegistryObservation(observation)
  }

  function scheduleOmpRegistryRefresh(observation: OmpRegistryObservation): void {
    if (!currentOmpRegistryObservation(observation)) return
    const executing = observation.pending || observation.rootExecuting || observation.status.state === 'working' || observation.status.state === 'blocked' || observation.status.state === 'waiting' || lifecycleState.active.size > 0
    if (!executing) {
      if (observation.refreshTimer !== null) clearTimeout(observation.refreshTimer)
      observation.refreshTimer = null
      return
    }
    if (observation.refreshTimer !== null) return
    observation.refreshTimer = setTimeout(() => {
      observation.refreshTimer = null
      reconcileOmpRegistry(observation, true)
    }, OMP_REGISTRY_REFRESH_MS)
    if (typeof observation.refreshTimer.unref === 'function') observation.refreshTimer.unref()
  }

  function scheduleOmpRegistryChange(observation: OmpRegistryObservation): void {
    if (!currentOmpRegistryObservation(observation)) return
    observation.pending = true
    if (observation.changeTimer !== null) return
    observation.changeTimer = setTimeout(() => {
      observation.changeTimer = null
      reconcileOmpRegistry(observation)
    }, OMP_REGISTRY_COALESCE_MS)
    if (typeof observation.changeTimer.unref === 'function') observation.changeTimer.unref()
  }

  function reconcileOmpRegistry(observation: OmpRegistryObservation, refresh = false): void {
    if (!currentOmpRegistryObservation(observation)) return
    let next: Map<string, SubagentDetail>
    try {
      const { registry, manager, root } = observation
      if (registry.get(root.id) !== root || root.kind !== 'main' || root.session?.sessionManager !== manager || manager.getSessionId?.() !== observation.sessionId || manager.getSessionFile?.() !== observation.sessionFile) {
        observation.roster.ownsPane = false
        retireOmpRegistryObservation(observation)
        return
      }
      const refs = registry.list()
      if (!Array.isArray(refs)) throw new Error('Invalid native registry snapshot')
      const byId = new Map<string, OmpNativeRef>()
      for (const ref of refs) {
        if (!ref || typeof ref.id !== 'string' || !ref.id || byId.has(ref.id)) throw new Error('Invalid native registry identity')
        byId.set(ref.id, ref)
      }
      if (byId.get(root.id) !== root) throw new Error('Native root missing from snapshot')
      observation.rootExecuting = isOmpNativeSessionExecuting(root.session)
      // An uncaptured baseline needs a successful native execution read.
      if (observation.rootBaselinePending) {
        observation.status.state = observation.rootExecuting ? 'working' : 'done'
        observation.rootBaselinePending = false
        observation.dirty = true
      }
      const paths = require('path')
      const rootArtifactFile = paths.resolve(observation.sessionFile)
      // Parent links prove tree ownership; the native artifact directory fences
      // retained generations whose stable Main id was reused by a session switch.
      type Ownership = 'owned' | 'pending' | 'foreign'
      // Memo belongs to this native read only; checking markers detect cycles
      // without recursion or revisiting shared inactive ancestry.
      const ownershipByRef = new Map<OmpNativeRef, Ownership | 'checking' | 'attaching'>([[root, 'owned']])
      const scope = (ref: OmpNativeRef): Ownership => {
        const cached = ownershipByRef.get(ref)
        if (cached === 'owned' || cached === 'pending' || cached === 'foreign') return cached
        const trail: OmpNativeRef[] = []
        let current: OmpNativeRef | undefined = ref
        let result: Ownership = 'foreign'
        while (current) {
          const known = ownershipByRef.get(current)
          if (known !== undefined) {
            if (known === 'owned' || known === 'pending') result = known
            break
          }
          if (current.kind !== 'sub') {
            ownershipByRef.set(current, 'foreign')
            break
          }
          if (registry.get(current.id) !== current) throw new Error('Native child identity changed during snapshot')
          let attaching = false
          if (typeof current.sessionFile === 'string' && current.sessionFile) {
            if (!isNestedTaskTranscript(rootArtifactFile, paths.resolve(current.sessionFile))) {
              ownershipByRef.set(current, 'foreign')
              break
            }
          } else if (current.status === 'running' && !current.session) {
            attaching = true
          } else {
            ownershipByRef.set(current, 'foreign')
            break
          }
          trail.push(current)
          ownershipByRef.set(current, attaching ? 'attaching' : 'checking')
          current = current.parentId ? byId.get(current.parentId) : undefined
        }
        for (let index = trail.length - 1; index >= 0; index--) {
          const ancestor = trail[index]!
          if (result !== 'foreign' && ownershipByRef.get(ancestor) === 'attaching') result = 'pending'
          ownershipByRef.set(ancestor, result)
        }
        return result
      }
      next = new Map<string, SubagentDetail>()
      let pending = false
      for (const ref of refs) {
        if (ref.kind !== 'sub' || (ref.status !== 'running' && ref.status !== 'idle')) continue
        // SDK terminalAt also marks async idle pauses; positive execution wins.
        let running: boolean
        try {
          running = !!ref.session && (isOmpNativeSessionExecuting(ref.session) || (typeof registry.isRunning === 'function' && registry.isRunning(ref) === true))
        } catch (error) {
          // Foreign sessions cannot make this root's membership unavailable.
          if (scope(ref) === 'foreign') continue
          throw error
        }
        if (!running && ref.status === 'idle') continue
        const ownership = scope(ref)
        if (ownership === 'foreign') continue
        if (ownership === 'pending' || (ref.status === 'running' && !running && ref.lifecycle?.acceptedAt === undefined && ref.lifecycle?.terminalAt === undefined)) {
          pending = true
          continue
        }
        if (!running) continue
        const old = subagentDetails.get(ref.id)
        const role = typeof ref.history?.agent === 'string' ? ref.history.agent : ref.displayName
        next.set(ref.id, {
          agentType: typeof role === 'string' && role.trim() ? role.slice(0, OMP_STATUS_ROLE_LIMIT) : undefined,
          description: ref.id,
          startedAt: typeof ref.createdAt === 'number' && Number.isFinite(ref.createdAt) ? ref.createdAt : old?.startedAt ?? Date.now(),
          parent: ref.parentId,
          registration: ompRegistryOwner
        })
      }
      // Registration may precede attachSession (which emits no registry event).
      // Do not turn that intermediate view into a fresh empty/full membership list.
      if (pending) {
        observation.pending = true
        observation.readUnavailable = true
        scheduleOmpRegistryRefresh(observation)
        return
      }
      if (registry.get(root.id) !== root || root.session?.sessionManager !== manager || manager.getSessionId?.() !== observation.sessionId || manager.getSessionFile?.() !== observation.sessionFile) {
        observation.roster.ownsPane = false
        retireOmpRegistryObservation(observation)
        return
      }
    } catch {
      observation.pending = true
      observation.readUnavailable = true
      scheduleOmpRegistryRefresh(observation)
      return
    }
    const recovered = observation.readUnavailable
    observation.pending = false
    observation.readUnavailable = false
    let changed = lifecycleState.active.size !== next.size
    for (const id of lifecycleState.active) {
      if (next.has(id)) continue
      forgetSubagent(id)
      changed = true
    }
    for (const [id, detail] of next) {
      const old = subagentDetails.get(id)
      if (!lifecycleState.active.has(id) || lifecycleState.exited?.has(id) || !old || old.agentType !== detail.agentType || old.description !== detail.description || old.startedAt !== detail.startedAt || old.parent !== detail.parent || old.workflow === true) changed = true
      lifecycleState.active.add(id)
      lifecycleState.exited?.delete(id)
      subagentDetails.set(id, detail)
    }
    observation.verified = true
    if (lifecycleState.waiting && lifecycleState.active.size === 0 && observation.status.state === 'done' && observation.status.session_boundary !== true) postAgentEndOnce()
    if (changed || observation.dirty || refresh || recovered) {
      observation.dirty = false
      post('subagents_update')
    }
    scheduleOmpRegistryRefresh(observation)
  }

  function updateOmpRegistryContext(ctx: OmpRegistryContext): void {
    if (!isOmpRuntime() || !lifecycleState.ownsPane || !ownsSessionStatus(ctx)) return
    const kind = ctx?.agent?.kind ?? ctx?.agentKind
    if (kind !== undefined && kind !== 'main') return
    const registry = getOmpNativeRegistry(pi)
    const previous = lifecycleState.ompRegistryObserver ?? ompRegistryObservation
    if (!registry) {
      if (previous) {
        if (previous.roster !== lifecycleState) previous.roster.ownsPane = false
        retireOmpRegistryObservation(previous)
      }
      return
    }
    const root = getOmpRegistryRootRef(pi, registry, ctx)
    const manager = ctx?.sessionManager
    if (!root || !manager) return
    let sessionId: unknown
    let sessionFile: unknown
    try {
      sessionId = manager.getSessionId?.()
      sessionFile = manager.getSessionFile?.()
    } catch { return }
    if (typeof sessionId !== 'string' || !sessionId || typeof sessionFile !== 'string' || !sessionFile) return
    const sameScope = previous && !previous.stopped && previous.registry === registry && previous.root === root && previous.manager === manager && previous.sessionId === sessionId && previous.sessionFile === sessionFile
    if (sameScope && previous.owner === ompRegistryOwner) {
      ompRegistryObservation = previous
      return
    }
    const priorStatus = sameScope ? previous.status : undefined
    const approvalPending = sameScope ? previous.approvalPending : false
    const approvalDetails = sameScope ? previous.approvalDetails : undefined
    const questionToolName = sameScope ? previous.questionToolName : undefined
    const identityBoundaryPending = sameScope ? previous.identityBoundaryPending : true
    let readUnavailable = sameScope ? previous.readUnavailable : false
    let rootExecuting = false
    let rootBaselinePending = sameScope ? previous.rootBaselinePending === true : false
    try { rootExecuting = isOmpNativeSessionExecuting(root.session) } catch {
      readUnavailable = true
      if (!priorStatus) rootBaselinePending = true
    }
    if (previous) {
      if (previous.roster !== lifecycleState) previous.roster.ownsPane = false
      retireOmpRegistryObservation(previous)
    }
    const observation: OmpRegistryObservation = {
      owner: ompRegistryOwner, roster: lifecycleState, registry, root, manager, sessionId, sessionFile,
      // Native registration starts at running even before the first prompt.
      status: priorStatus ?? { state: rootExecuting ? 'working' : 'done', session_boundary: true },
      identityBoundaryPending, readUnavailable,
      approvalPending, approvalDetails, questionToolName, subscribed: false, stopped: false, verified: false, pending: true,
      rootExecuting, rootBaselinePending, dirty: true, changeTimer: null, refreshTimer: null
    }
    lifecycleState.ompRegistryObserver = observation
    ompRegistryObservation = observation
    try {
      // Subscribe first: a start between binding and enumeration must be reconciled.
      const unsubscribe = registry.onChange(event => {
        if (!currentOmpRegistryObservation(observation)) return
        if (event?.type !== 'registered' && event?.type !== 'status_changed' && event?.type !== 'metadata_changed' && event?.type !== 'removed') return
        scheduleOmpRegistryChange(observation)
      })
      if (typeof unsubscribe !== 'function') throw new Error('Invalid native registry subscription')
      observation.unsubscribe = unsubscribe
      observation.subscribed = true
    } catch {
      retireOmpRegistryObservation(observation)
      return
    }
    scheduleOmpRegistryChange(observation)
    scheduleOmpRegistryRefresh(observation)
  }
`
      .trimEnd()
      .split('\n'),
    ...getOmpRootStatusSourceLines()
  ]
}
