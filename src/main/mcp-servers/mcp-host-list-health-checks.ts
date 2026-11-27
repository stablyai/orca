// The host list's problems check: one per agent and scope at a time, shared by every client that
// asks meanwhile. A client that lets go drops only its own interest; the check, with its CLI and
// servers, stops once nobody is left waiting on it.
import type { BotToolProblem } from '../../shared/bot-tools'

type Problems = Record<string, BotToolProblem>
/** One request under way, and the client that made it. */
type WaitingRequest = { readonly client: string }
type Check = {
  controller: AbortController
  result: Promise<Problems>
  waiting: Set<WaitingRequest>
}

const checks = new Map<string, Check>()

function leave(key: string, check: Check, request: WaitingRequest): void {
  if (!check.waiting.delete(request) || check.waiting.size > 0) {
    return
  }
  check.controller.abort()
  if (checks.get(key) === check) {
    checks.delete(key)
  }
}

/**
 * Runs `run` for `key`, or joins the run under way. `client` names the asker for
 * `cancelHostListHealthChecks`; `signal` ending (its request cancelled or its connection gone)
 * drops this request's interest too.
 */
export async function joinHostListHealthCheck(
  key: string,
  client: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<Problems>
): Promise<Problems> {
  signal?.throwIfAborted()
  let check = checks.get(key)
  if (!check) {
    const controller = new AbortController()
    const started = run(controller.signal)
    const created: Check = {
      controller,
      waiting: new Set(),
      result: started.finally(() => {
        if (checks.get(key) === created) {
          checks.delete(key)
        }
      })
    }
    checks.set(key, created)
    check = created
  }
  const joined = check
  const request: WaitingRequest = { client }
  joined.waiting.add(request)
  const letGo = (): void => leave(key, joined, request)
  signal?.addEventListener('abort', letGo, { once: true })
  try {
    return await joined.result
  } finally {
    signal?.removeEventListener('abort', letGo)
    joined.waiting.delete(request)
  }
}

/** `client` lets go of every check it asked for; a check nobody else waits on stops. */
export function cancelHostListHealthChecks(client: string): void {
  for (const [key, check] of checks) {
    for (const request of check.waiting) {
      if (request.client === client) {
        leave(key, check, request)
      }
    }
  }
}
