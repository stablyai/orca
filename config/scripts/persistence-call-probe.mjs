export function installPersistenceCallProbe() {
  const store = globalThis.__orcaLiveStoreProbeTarget
  if (!store || globalThis.__orcaPersistenceCallProbe) {
    throw new Error('Missing verified live store, or probe already active')
  }
  const contextSymbol = Object.getOwnPropertySymbols(store).find(
    (symbol) => symbol.description === 'PrimaryStateWriteOperations'
  )
  const serialization = store[contextSymbol]?.serialization
  if (!serialization?.buildStateToSave) {
    throw new Error('Live serialization context was not found')
  }
  const events = []
  const cleanup = []
  function wrap(object, name, describe) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name)
    const original = object[name]
    const wrapped = function (...args) {
      const details = describe?.(args) ?? {}
      const start = performance.now()
      const epoch = Date.now()
      let result
      try {
        result = Reflect.apply(original, this, args)
        return result
      } finally {
        const durationMs = performance.now() - start
        if (events.length < 1000) {
          events.push({
            name,
            epoch,
            durationMs,
            ...details,
            payloadBytes: name === 'buildStateToSave' ? result?.payload?.length : undefined,
            stack:
              durationMs > 20
                ? new Error('Persistence timing').stack?.split('\n').slice(2, 9)
                : undefined
          })
        }
      }
    }
    Object.defineProperty(object, name, { value: wrapped, configurable: true, writable: true })
    cleanup.push(() => {
      if (object[name] !== wrapped) {
        return
      }
      if (descriptor) {
        Object.defineProperty(object, name, descriptor)
      } else {
        delete object[name]
      }
    })
  }
  wrap(serialization, 'buildStateToSave')
  wrap(store, 'flushOrThrow')
  wrap(store, 'persistPtyBinding', ([args, hostId]) => {
    if (hostId && hostId !== 'local') {
      return { local: false }
    }
    const session = store.getWorkspaceSession()
    const key = `${args.tabId}:${args.leafId}`
    const worktreeId = args.expectedSourceBinding?.worktreeId ?? args.worktreeId
    const tab = session.tabsByWorktree?.[worktreeId]?.find((t) => t.id === args.tabId)
    return {
      local: true,
      tabAlreadyBound: tab?.ptyId === args.ptyId,
      leafAlreadyBound:
        session.terminalLayoutsByTabId?.[args.tabId]?.ptyIdsByLeafId?.[args.leafId] === args.ptyId,
      incarnationAlreadyMatches:
        session.terminalPtyIncarnationsByPaneKey?.[key] === args.incarnationId,
      layoutExists: !!session.terminalLayoutsByTabId?.[args.tabId]?.root
    }
  })
  globalThis.__orcaPersistenceCallProbe = {
    stop() {
      for (const restore of cleanup.toReversed()) {
        restore()
      }
      delete globalThis.__orcaPersistenceCallProbe
      delete globalThis.__orcaLiveStoreProbeTarget
      return { events }
    }
  }
}
