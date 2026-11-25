import { useEffect, useState } from 'react'
import * as z from 'zod'
import {
  bindDeferredRpcOperation,
  defineRpcOperation
} from '../../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../../transport/connection/connection-state'
import type { WorkerDockPresence } from '../../../../../../src/shared/agent-session/background-tasks/agent-session-background-task-wire'
import {
  WorkerDockSnapshot,
  type WorkerDockEntry
} from '../../../../../../src/shared/orchestration/dock/worker-dock'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../src/shared/agent-session/identity/orca-session-address'

const NONE: readonly WorkerDockEntry[] = []

const seedRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'orchestration.worker-dock-seed',
    method: 'orchestration.workerDockRead',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worker-dock-seed', z.unknown())
  })
)

// A refusal is an older host's answer; anything else (a relayed server's socket reset) is retried.
const REFUSALS = new Set(['forbidden', 'method_not_found', 'unsupported_method'])
const RETRY_MS = 5_000

/** A coordinator chat's current workers (live ones and recent failures), from the host that runs
 *  them; read only while the chat's background-task feed says it has some. */
export function useMobileWorkerDock({
  client,
  connState,
  sessionId,
  presence
}: {
  client: RpcClient | null
  connState: ConnectionState
  sessionId: string | null
  presence: WorkerDockPresence | undefined
}): readonly WorkerDockEntry[] {
  const party = sessionId && isOrcaSessionId(sessionId) ? formatOrcaSessionAddress(sessionId) : null
  const connected = connState === 'connected'
  const [rows, setRows] = useState<{ party: string; list: readonly WorkerDockEntry[] } | null>(null)
  // Bumped to reopen a stream that ended other than by refusal.
  const [attempt, setAttempt] = useState(0)

  // A chat the host hasn't indexed since it started has no presence until one read seeds it, as the
  // desktop's cold seed does. Once seeded the host answers it empty, so each visit asks again.
  const unseen = presence === undefined
  useEffect(() => {
    if (client && connected && party && unseen) {
      void seedRead
        .request(client, { party, seed: true, includeRows: false, currentOnly: true })
        .catch(() => {})
    }
  }, [client, connected, party, unseen])

  const open = presence?.open === true
  useEffect(() => {
    if (!client || !connected || !party || !open) {
      setRows(null)
      return
    }
    let revision = -1
    let retry: ReturnType<typeof setTimeout> | undefined
    const stop = client.subscribe(
      'orchestration.workerDockSubscribe',
      { party, includeRows: true, currentOnly: true },
      (raw) => {
        const parsed = WorkerDockSnapshot.safeParse(raw)
        if (parsed.success) {
          const snapshot = parsed.data
          if (snapshot.revision >= revision) {
            revision = snapshot.revision
            setRows({ party, list: snapshot.unavailable ? NONE : currentRows(snapshot) })
          }
          return
        }
        if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
          // A snapshot this build can't read (a newer host's state): show none rather than stale rows.
          setRows(null)
          return
        }
        if (raw.type !== 'end' && raw.type !== 'error') {
          return
        }
        const error = 'error' in raw && typeof raw.error === 'object' ? raw.error : null
        const code = error && 'code' in error ? String(error.code) : ''
        setRows(null)
        if (retry === undefined && !REFUSALS.has(code)) {
          retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS)
        }
      }
    )
    return () => {
      clearTimeout(retry)
      stop()
    }
  }, [attempt, client, connected, party, open])

  return rows?.party === party ? rows.list : NONE
}

/** Each listed worker with its identity's lifecycle, which a cached detail can lag. */
function currentRows(snapshot: WorkerDockSnapshot): readonly WorkerDockEntry[] {
  const details = new Map(snapshot.rows.map((row) => [row.id, row]))
  const list = snapshot.identities.flatMap((identity) => {
    const row = details.get(identity.id)
    return row
      ? [
          {
            ...row,
            state: identity.state,
            changedAt: identity.changedAt,
            settlement: identity.settlement
          }
        ]
      : []
  })
  return list.length ? list : NONE
}
