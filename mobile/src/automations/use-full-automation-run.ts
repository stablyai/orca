import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { automationRunRead } from './automation-operations'
import type { MobileAutomationRun } from './automation-reply-schema'
import type { AutomationRunScope } from './use-automation-runs'

/** History lists cut output to a preview marked truncated, so Details reads that run's full row. */
export function useFullAutomationRun(
  client: RpcClient | null,
  connected: boolean,
  run: MobileAutomationRun,
  scope: AutomationRunScope
): MobileAutomationRun {
  const expectedOwner = scope?.automationId === run.automationId ? scope.expectedOwner : undefined
  // A new status or capture re-reads; untruncated rows were never cut.
  const key = run.outputSnapshot?.truncated
    ? JSON.stringify([run.id, run.status, run.outputSnapshot.capturedAt, expectedOwner ?? null])
    : null
  const latest = useRef(expectedOwner)
  useLayoutEffect(() => {
    latest.current = expectedOwner
  })
  const [full, setFull] = useState<{ key: string; run: MobileAutomationRun } | null>(null)
  const loaded = full?.key === key
  // A failed read keeps the preview, marked truncated; a reconnect or the next history read of the row retries.
  useEffect(() => {
    if (!key || loaded || !client || !connected) {
      return
    }
    const expectedOwner = latest.current
    const generation = client.getGeneration?.()
    let current = true
    automationRunRead
      .request(client, {
        automationId: run.automationId,
        runId: run.id,
        ...(expectedOwner ? { expectedOwner } : {}),
        // An old host ignores `runId` and lists; one row keeps that answer small.
        limit: 1
      })
      .then((reply) => {
        const read = automationRunRead.interpret(reply).run
        if (current && generation === client.getGeneration?.() && read?.id === run.id) {
          setFull({ key, run: read })
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client, connected, key, loaded, run])
  return loaded ? full.run : run
}
