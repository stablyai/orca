/** Restrict every forwarded browser selector to the host-approved workspace; never widen into desktop worktrees. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { BrowserError } from '../../browser/browser-error'
import {
  DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNROUTED_CODE
} from '../../../shared/desktop-browser-bridge-protocol'

type RemoteCliBrowserScope = {
  workspaceId: string
  revoked?: AbortSignal
  /** Attachment lifetime, independent of individual command cancel/deadline. */
  hostRevoked?: AbortSignal
  admitGuest?: (webContentsId: number) => boolean
}

const scope = new AsyncLocalStorage<RemoteCliBrowserScope>()

export function runInRemoteCliBrowserScope<T>(
  workspaceId: string,
  run: () => Promise<T>,
  revoked?: AbortSignal,
  admitGuest?: (webContentsId: number) => boolean,
  hostRevoked?: AbortSignal
): Promise<T> {
  return scope.run(
    {
      workspaceId,
      ...(revoked ? { revoked } : {}),
      ...(admitGuest ? { admitGuest } : {}),
      ...(hostRevoked ? { hostRevoked } : {})
    },
    run
  )
}

/** Recheck at queue execution so a detached issuer cannot start delayed commands. */
export function captureRemoteCliBrowserRevocation(): (webContentsId?: number) => void {
  const active = scope.getStore()
  return (webContentsId) => {
    if (active?.revoked?.aborted) {
      throw new BrowserError(
        DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
        'The Orca desktop stopped sharing its browser before this command ran.'
      )
    }
    // Routing may be disabled and the guest remounted while this command queues.
    if (webContentsId !== undefined && active?.admitGuest && !active.admitGuest(webContentsId)) {
      throw new BrowserError(
        DESKTOP_BROWSER_BRIDGE_UNROUTED_CODE,
        "This page is not browsing through the SSH host, so the host's orca CLI cannot use it."
      )
    }
  }
}

/** Restore the captured command scope (including none), never the queue runner's possibly different host. */
export function captureRemoteCliBrowserScope(): {
  bridged: boolean
  revoked?: AbortSignal
  hostRevoked?: AbortSignal
  run<T>(work: () => T): T
} {
  const active = scope.getStore()
  return {
    bridged: active !== undefined,
    revoked: active?.revoked,
    hostRevoked: active?.hostRevoked,
    run: (work) => (active ? scope.run(active, work) : scope.exit(work))
  }
}

/** The workspace an SSH host's command is scoped to, if this call came through the bridge. */
export function remoteCliBrowserScopeWorkspaceId(): string | undefined {
  return scope.getStore()?.workspaceId
}

/** Prevent long-lived resources from inheriting a command's host scope. */
export function runOutsideRemoteCliBrowserScope<T>(work: () => T): T {
  return scope.exit(work)
}

export function assertRemoteCliBrowserAccess(webContentsId?: number): void {
  captureRemoteCliBrowserRevocation()(webContentsId)
}

export function resolveRemoteCliBrowserScopeSelector(
  selector: string
): Promise<{ id: string }> | null {
  const active = scope.getStore()
  if (!active) {
    return null
  }
  if (selector === `id:${active.workspaceId}`) {
    return Promise.resolve({ id: active.workspaceId })
  }
  return Promise.reject(
    new BrowserError(
      DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
      'An SSH host can only reach browser tabs in its own workspaces.'
    )
  )
}

export const REMOTE_CLI_EVAL_TIMEOUT_MS = 30_000

/** Bound bridged work by deadline/revocation and cancel it on either; local work passes through. */
export function boundRemoteCliBrowserWork<T>(
  work: Promise<T>,
  cancel: () => void,
  timeoutMs = REMOTE_CLI_EVAL_TIMEOUT_MS
): Promise<T> {
  const active = scope.getStore()
  if (!active) {
    return work
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onRevoked = (): void => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    const interrupt = (error: BrowserError): void => {
      cancel()
      reject(error)
    }
    onRevoked = () =>
      interrupt(
        new BrowserError(
          DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
          'The Orca desktop stopped sharing its browser while this command ran.'
        )
      )
    timer = setTimeout(
      () =>
        interrupt(
          new BrowserError(
            'browser_timeout',
            `The page script did not finish within ${Math.round(timeoutMs / 1000)}s.`
          )
        ),
      timeoutMs
    )
    if (active.revoked?.aborted) {
      onRevoked()
    } else {
      active.revoked?.addEventListener('abort', onRevoked, { once: true })
    }
  })
  // Handle interruption rejection even when work already won the race.
  interrupted.catch(() => {})
  return Promise.race([work, interrupted]).finally(() => {
    clearTimeout(timer)
    active.revoked?.removeEventListener('abort', onRevoked)
  })
}

export function captureRemoteCliBrowserWorkBound(): <T>(
  work: Promise<T>,
  cancel: () => void
) => Promise<T> {
  const active = scope.getStore()
  return (work, cancel) =>
    active ? scope.run(active, () => boundRemoteCliBrowserWork(work, cancel)) : work
}
