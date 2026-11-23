import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { RpcClient } from '../rpc/rpc-client-contract'

export type DirectCandidate = {
  path: 'lan' | 'tailscale'
  open: () => RpcClient
  timeoutMs: number
}

type AuthenticatedCandidate = { path: DirectCandidate['path']; client: RpcClient }

// Give LAN a small head start, but do not wait for its entire timeout before trying Tailscale.
const SECONDARY_DIAL_DELAY_MS = 250

function delayOrCancel(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms === 0) {
      resolve()
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

// The first authenticated path wins; canceled and losing sockets are always closed.
export async function openPreferredDirectCandidate(
  candidates: readonly DirectCandidate[],
  signal: AbortSignal
): Promise<AuthenticatedCandidate | null> {
  if (candidates.length === 0 || signal.aborted) {
    return null
  }
  const controller = new AbortController()
  const cancel = (): void => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  const opened: RpcClient[] = []
  let winner: AuthenticatedCandidate | null = null
  try {
    winner = await Promise.any(
      candidates.map(async (candidate, index) => {
        await delayOrCancel(index * SECONDARY_DIAL_DELAY_MS, controller.signal)
        const client = await openAuthenticatedDirectEndpoint(
          candidate.open,
          candidate.timeoutMs,
          controller.signal
        )
        if (!client || controller.signal.aborted) {
          client?.close()
          throw new Error('Direct candidate unavailable')
        }
        opened.push(client)
        return { client, path: candidate.path }
      })
    )
    if (signal.aborted) {
      winner.client.close()
      winner = null
    }
    return winner
  } catch {
    return null
  } finally {
    controller.abort()
    signal.removeEventListener('abort', cancel)
    for (const client of opened) {
      if (client !== winner?.client) {
        client.close()
      }
    }
  }
}
