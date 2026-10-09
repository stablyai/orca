// The shadow self-check on Store writes, in dev and e2e runs only: each written partition must load
// and save to a fixed point (idempotence). Findings are logged by kind, and so is each kind of
// first-load change the first time a host shows it; nothing is thrown and nothing is written.

import type { ExecutionHostId } from '../../shared/execution-host'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import { checkLayoutRoundTrip } from '../../shared/workspace-layout/workspace-layout-round-trip-check'
import type { RuntimeStore } from './runtime-store-contract'

const SETTLE_MS = 1000

type WatchedStore = Pick<
  RuntimeStore,
  'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'onWorkspaceSessionWritten'
>

export function shouldWatchLayoutRoundTrip(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === 'development' ||
    Boolean(env.ORCA_E2E_USER_DATA_DIR) ||
    env.ORCA_LAYOUT_ROUND_TRIP_CHECK === '1'
  )
}

/** Checks each partition a burst of writes changed, once the burst settles. */
export function watchLayoutRoundTrip(store: WatchedStore): () => void {
  const checked = new Map<ExecutionHostId, string>()
  const loggedKinds = new Map<ExecutionHostId, Set<string>>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const check = (): void => {
    timer = null
    for (const hostId of store.getWorkspaceSessionHostIds?.() ?? []) {
      const session = store.getWorkspaceSession?.(hostId)
      const json = session ? stableJson(session) : ''
      if (!session || checked.get(hostId) === json) {
        continue
      }
      checked.set(hostId, json)
      const { findings, firstLoadChanges } = checkLayoutRoundTrip(hostId, session)
      const hostKind = hostId.split(':')[0]
      if (findings.length > 0) {
        console.warn('[workspace-layout] round-trip check:', hostKind, findings)
      }
      const logged = loggedKinds.get(hostId) ?? new Set<string>()
      loggedKinds.set(hostId, logged)
      if (Object.keys(firstLoadChanges).some((kind) => !logged.has(kind))) {
        Object.keys(firstLoadChanges).forEach((kind) => logged.add(kind))
        console.info('[workspace-layout] first-load changes:', hostKind, firstLoadChanges)
      }
    }
  }
  const stop = store.onWorkspaceSessionWritten?.(() => {
    timer ??= setTimeout(check, SETTLE_MS)
  })
  return () => {
    stop?.()
    if (timer) {
      clearTimeout(timer)
    }
  }
}
