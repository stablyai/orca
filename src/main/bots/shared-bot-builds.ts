// Callers of one per-bot host read share its builds, so more open clients do not multiply the work.
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/** A build in flight, and the one queued behind it for callers who arrived while it ran. */
type SharedBuild<T> = { result: Promise<T>; rerun: Promise<T> | null }

const settled = (): void => {}

/** A caller arriving mid-build may have seen a change that build missed, so it gets one more build
 *  after it, shared with later arrivals. Builds are kept per runtime, then per bot. */
export function createSharedBotBuilds<T>(): (
  runtime: OrcaRuntimeService,
  botId: string,
  build: () => Promise<T>
) => Promise<T> {
  const buildsByRuntime = new WeakMap<OrcaRuntimeService, Map<string, SharedBuild<T>>>()

  const start = (builds: Map<string, SharedBuild<T>>, botId: string, build: () => Promise<T>) => {
    const entry: SharedBuild<T> = { result: build(), rerun: null }
    builds.set(botId, entry)
    void entry.result.then(settled, settled).then(() => {
      if (builds.get(botId) === entry) {
        builds.delete(botId)
      }
    })
    return entry.result
  }

  return (runtime, botId, build) => {
    let builds = buildsByRuntime.get(runtime)
    if (!builds) {
      builds = new Map()
      buildsByRuntime.set(runtime, builds)
    }
    const current = builds.get(botId)
    if (!current) {
      return start(builds, botId, build)
    }
    const target = builds
    current.rerun ??= current.result.then(settled, settled).then(() => start(target, botId, build))
    return current.rerun
  }
}
