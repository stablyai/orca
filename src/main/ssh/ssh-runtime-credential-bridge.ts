import { randomUUID } from 'node:crypto'
import { SSH_CREDENTIAL_TIMEOUT_MS } from './connection/ssh-connection-timing'
import type { SshCredentialKind } from './connection/ssh-connection-callbacks'
import { recordSshCredentialDeclined } from './authentication/ssh-credential-decline'

type SshCredentialRequest = {
  requestId: string
  targetId: string
  kind: SshCredentialKind
  detail: string
  echo?: boolean
}

type CredentialRuntime = {
  notifySshCredentialRequest(request: SshCredentialRequest): void
  notifySshCredentialResolved(requestId: string): void
}

type PendingCredential = {
  targetId: string
  resolve: (value: string | null) => void
  close: () => void
}

const pendingRequests = new Map<string, PendingCredential>()
let activeRuntime: CredentialRuntime | null = null

function resolveRequest(requestId: string, value: string | null): void {
  pendingRequests.get(requestId)?.resolve(value)
}

function closeRequest(requestId: string): void {
  pendingRequests.get(requestId)?.close()
}

/** Installs the request/reply bridge owned by the headless runtime, not by Electron IPC. */
export function installSshRuntimeCredentialBridge(
  runtime: CredentialRuntime,
  registerCleanup: (cleanup: () => void) => void
): void {
  activeRuntime = runtime
  registerCleanup(() => {
    if (activeRuntime === runtime) {
      activeRuntime = null
    }
    for (const requestId of pendingRequests.keys()) {
      closeRequest(requestId)
    }
  })
}

export function requestSshRuntimeCredential(
  targetId: string,
  kind: SshCredentialKind,
  detail: string,
  echo?: boolean,
  signal?: AbortSignal
): Promise<string | null> {
  const runtime = activeRuntime
  if (!runtime) {
    return Promise.resolve(null)
  }

  const requestId = randomUUID()
  const { promise, resolve } = Promise.withResolvers<string | null>()
  let timer: ReturnType<typeof setTimeout>
  const finish = (value: string | null, declined: boolean): void => {
    if (!pendingRequests.delete(requestId)) {
      return
    }
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    runtime.notifySshCredentialResolved(requestId)
    if (declined) {
      recordSshCredentialDeclined(targetId, signal)
    }
    resolve(value)
  }
  const onAbort = (): void => finish(null, false)
  const decline = (): void => {
    if (!pendingRequests.has(requestId)) {
      return
    }
    finish(null, true)
    // One cancel answers this target; queued prompts must not open after the user declined.
    for (const [otherId, other] of pendingRequests) {
      if (otherId !== requestId && other.targetId === targetId) {
        other.close()
      }
    }
  }

  timer = setTimeout(decline, SSH_CREDENTIAL_TIMEOUT_MS)
  pendingRequests.set(requestId, {
    targetId,
    resolve: (value) => (value === null ? decline() : finish(value, false)),
    close: () => finish(null, false)
  })
  if (signal?.aborted) {
    onAbort()
    return promise
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  runtime.notifySshCredentialRequest({
    requestId,
    targetId,
    kind,
    detail,
    ...(echo === undefined ? {} : { echo })
  })
  return promise
}

/** Answers only an outstanding request; the secret never enters a client event. */
export function submitSshRuntimeCredential(requestId: string, value: string | null): boolean {
  if (!pendingRequests.has(requestId)) {
    return false
  }
  resolveRequest(requestId, value)
  return true
}
