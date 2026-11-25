/** WSL hosts whose orcad said it stopped idle (#46567): held down until a user's wake. */
import { clearRuntimeEnvironmentContactLoss } from '../../ipc/runtime-environments/status/runtime-environment-contact-loss'
import type { WslOrcadConnectionStatus } from '../orcad/wsl-orcad-connection-status'
import type { WslOrcadConnection } from '../orcad/wsl-orcad-connection-types'
import { defaultWslOrcadEnvironmentId } from '../orcad/wsl-orcad-environment-id'

// orcad's shutdown deadline is 15 s; a wake waits this long at most for the old process to go.
const OLD_ORCAD_EXIT_WAIT_MS = 16_000

type IdleStop = {
  /** Resolves once liveness saw the stopped orcad exit, so a wake cannot reach the dying one. */
  exited: PromiseWithResolvers<void>
  /** The one wake in flight, which every later user call joins. */
  waking: Promise<void> | null
}

const idleStopped = new Map<string, IdleStop>()
const clearedListeners = new Set<(environmentId: string) => void>()

/** The host's own close said idle stop; that close was an answer, so it is no lost contact. */
export function noteWslHostIdleStop(environmentId: string): void {
  if (!idleStopped.has(environmentId)) {
    idleStopped.set(environmentId, { exited: Promise.withResolvers<void>(), waking: null })
  }
  clearRuntimeEnvironmentContactLoss(environmentId)
}

/** True from the idle-stop close until a woken server is ready, waking included. */
export function isWslHostIdleStopped(environmentId: string): boolean {
  return idleStopped.has(environmentId)
}

/** Hears every end of a hold, so held control sockets reopen and replay their streams. */
export function onWslHostIdleStopCleared(listener: (environmentId: string) => void): () => void {
  clearedListeners.add(listener)
  return () => clearedListeners.delete(listener)
}

function clearWslHostIdleStop(environmentId: string): void {
  if (idleStopped.delete(environmentId)) {
    for (const listener of clearedListeners) {
      listener(environmentId)
    }
  }
}

/** Every connect to an idle-stopped host (a wake, Start, a due automation) first lets the old
 *  orcad finish exiting, or it would reach the fenced one. */
export async function waitForIdleStoppedOrcadExit(environmentId: string): Promise<void> {
  const stop = idleStopped.get(environmentId)
  if (!stop) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, OLD_ORCAD_EXIT_WAIT_MS)
  })
  await Promise.race([stop.exited.promise, waited])
  clearTimeout(timer)
}

/** Single-flight: the first user call boots it; later calls join that wake. */
export function wakeWslHostAfterIdleStop(
  environmentId: string,
  connect: () => Promise<void>
): Promise<void> {
  const stop = idleStopped.get(environmentId)
  if (!stop) {
    return connect()
  }
  stop.waking ??= connect()
    .then(() => clearWslHostIdleStop(environmentId))
    .finally(() => {
      stop.waking = null
    })
  return stop.waking
}

/** The wake already in flight, which a call that is neither a wake nor a poll may wait on. */
export function pendingWslHostWake(environmentId: string): Promise<void> | null {
  return idleStopped.get(environmentId)?.waking ?? null
}

/** Liveness reports: ready ends the hold; idle (or the distro stopping) means the old orcad left. */
export function withWslHostIdleStop(
  distro: string,
  connection: WslOrcadConnection | null,
  status: WslOrcadConnectionStatus
): WslOrcadConnectionStatus {
  const environmentId = connection?.environmentId ?? defaultWslOrcadEnvironmentId(distro)
  const stop = idleStopped.get(environmentId)
  if (status.state === 'ready') {
    clearWslHostIdleStop(environmentId)
  } else if (stop && (status.state === 'idle' || status.state === 'distro-stopped')) {
    stop.exited.resolve()
  }
  // The distro stopping after an idle stop is that stop's doing, not one that offers Start.
  return stop && status.state === 'distro-stopped'
    ? { state: 'idle', terminals: 'unverifiable' }
    : status
}
