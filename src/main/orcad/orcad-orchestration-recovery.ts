import type { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'

/** Serializes authority refresh before worker adoption across delegated reconnects. */
export function installOrcadOrchestrationRecovery(options: {
  lifetime: OrcadRuntimeLifetime
  refreshAuthority: () => Promise<void>
  reconcileWorkers: () => Promise<unknown>
  onError: (error: unknown) => void
}) {
  let started = false
  let stopped = false
  let generation = 0
  let dirty = false
  let pending: Promise<void> | undefined
  const run = (): Promise<void> => {
    pending ??= Promise.resolve()
      .then(async () => {
        while (dirty && !stopped) {
          dirty = false
          const observedGeneration = generation
          try {
            await options.refreshAuthority()
            if (stopped) {
              return
            }
            if (observedGeneration !== generation) {
              continue
            }
            await options.reconcileWorkers()
          } catch (error) {
            if (stopped) {
              return
            }
            if (dirty) {
              continue
            }
            throw error
          }
        }
      })
      .finally(() => {
        pending = undefined
        if (dirty && !stopped) {
          return run()
        }
        return undefined
      })
    return pending
  }
  const stop = async () => {
    stopped = true
    await pending?.catch(() => {})
  }
  options.lifetime.add(stop)
  return {
    stop,
    start: async () => {
      if (stopped) {
        throw new Error('orcad_orchestration_recovery_stopped')
      }
      started = true
      dirty = true
      await run()
    },
    notify: () => {
      if (stopped) {
        return
      }
      generation += 1
      dirty = true
      if (started && !pending) {
        void run().catch((error) => {
          if (!stopped) {
            try {
              options.onError(error)
            } catch {
              // Diagnostics cannot escape the background recovery task.
            }
          }
        })
      }
    }
  }
}
