import type { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TerminalSpawnGate } from './terminal-spawn-gate'
import { SessionTerminationController } from './session-termination-controller'
import { shutdownOwnedTerminalProcess } from './terminal-host-session-shutdown'

/** Retain the returned resource, not the completed create request or publication dependencies. */
export function observeReturnedTerminalProcess(
  subprocess: SubprocessHandle,
  sessionId: string,
  spawnGate: TerminalSpawnGate | undefined
) {
  const exited = Promise.withResolvers<void>()
  let code: number | null = null
  let exitCause: TerminalExitCause | undefined
  let sessionExit: Parameters<SubprocessHandle['onExit']>[0] | undefined
  const rawTermination = new SessionTerminationController({
    sessionId,
    subprocess,
    isExited: () => code !== null,
    releaseProducerPause: ({ resume }) => {
      if (resume) {
        subprocess.resume?.()
      }
    }
  })
  let recoverCreated = () =>
    shutdownOwnedTerminalProcess({
      pid: subprocess.pid,
      isAlive: () => code === null,
      terminateOwnedTree: () => subprocess.terminateOwnedTree(),
      close: async () => {
        await rawTermination.forceKillAndWaitForExit()
        rawTermination.disposeSubprocessHandle()
      }
    })
  let observing = false
  const observeExit = (): void => {
    if (observing || code !== null) {
      return
    }
    subprocess.onExit((value, cause) => {
      if (code !== null) {
        return
      }
      code = value
      exitCause = cause
      rawTermination.markPhysicalExit()
      spawnGate?.onSessionExit(sessionId)
      exited.resolve()
      sessionExit?.(value, cause)
    })
    observing = true
    subprocess.onExit = (callback) => {
      sessionExit = callback
      if (code !== null) {
        callback(code, exitCause)
      }
    }
  }
  return {
    observeExit,
    completion: exited.promise,
    exitCode: () => code,
    recover: async () => {
      try {
        observeExit()
      } catch {
        // Recovery still owns signaling when the adapter cannot yet observe exit.
      }
      await recoverCreated()
    },
    useRecovery: (recover: () => Promise<void>) => {
      recoverCreated = recover
    }
  }
}

export function recoverUnpublishedTerminalSession(
  session: Pick<
    Session,
    'pid' | 'isAlive' | 'terminateOwnedTree' | 'forceKillAndWaitForExit' | 'dispose'
  >
): () => Promise<void> {
  return () =>
    shutdownOwnedTerminalProcess({
      pid: session.pid,
      isAlive: () => session.isAlive,
      terminateOwnedTree: () => session.terminateOwnedTree(),
      close: async () => {
        await session.forceKillAndWaitForExit()
        session.dispose()
      }
    })
}

export function terminalSessionExitCode(session: Pick<Session, 'exitCode'>): () => number | null {
  return () => session.exitCode
}
