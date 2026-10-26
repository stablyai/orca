import { agentHookServer, type AgentHookServer } from '../agent-hooks/server'
import type {
  JcodeSpawnListener,
  JcodeSpawnOutcome
} from '../agent-hooks/server/server-jcode-spawn'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { buildJcodeRuntimeDir, shouldInjectJcodeRuntimeDir } from '../../shared/jcode-runtime-dir'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import type { JcodeSpawnRequest } from '../../shared/jcode-spawn-hook'
import { registerPaneKeyTeardownListener } from '../ipc/pty/pane/key-state'
import type { ExternalAgentParentLink } from '../runtime/runtime-external-parent-links'
import type { TerminalCreateOptions } from '../runtime/runtime-terminal-contracts'
import { allocateTerminalPaneIdentity } from '../runtime/runtime-terminal-pane-identity'
import { forgetJcodePaneSecret, verifyJcodePaneSecret } from './jcode-pane-secrets'
import { decideJcodeSpawn } from './jcode-spawn-decision'
import { bestEffortJcodeCleanup, retireJcodePane } from './jcode-pane-retirement'

export type JcodeSpawnHandlerDeps = {
  runtime: {
    hasLiveTerminalForPaneKey(paneKey: string): boolean
    getTerminalHandleForPaneKey(paneKey: string): string | null
    getTerminalWorktreeIdForHandle(handle: string): string | null
    resolveTerminalWorkspaceLaunchScope(selector: string): Promise<{ path: string }>
    createTerminal(selector: string, opts: TerminalCreateOptions): Promise<{ handle: string }>
    focusTerminal(handle: string, options: { navigateHost: boolean }): Promise<unknown>
    closeTerminalTab(handle: string): Promise<unknown>
    setExternalAgentParentLink(paneKey: string, link: ExternalAgentParentLink): void
    clearExternalAgentParentLink(paneKey: string): void
  }
  server: Pick<
    AgentHookServer,
    | 'rootJcodeSessionId'
    | 'findJcodeSessionOwner'
    | 'reserveJcodeSessionTab'
    | 'confirmJcodeSessionTab'
    | 'releaseJcodeSessionTab'
    | 'bindJcodeDisplaySession'
    | 'settleJcodeDisplayPane'
    | 'clearPaneState'
  >
  verifyJcodePaneSecret: typeof verifyJcodePaneSecret
}

function waitForCreation(
  pending: Promise<string | null>,
  signal: AbortSignal
): Promise<string | null> {
  return new Promise((resolve) => {
    const abort = () => {
      resolve(null)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
    void pending.then((paneKey) => {
      signal.removeEventListener('abort', abort)
      resolve(paneKey)
    })
  })
}

export function createJcodeSpawnHandler(deps: JcodeSpawnHandlerDeps): JcodeSpawnListener {
  const { runtime, server } = deps
  const inFlight = new Map<string, Promise<string | null>>()

  async function focus(
    request: JcodeSpawnRequest,
    paneKey: string,
    creating: boolean,
    signal: AbortSignal
  ): Promise<JcodeSpawnOutcome> {
    if (creating) {
      const pending = inFlight.get(request.sessionId)
      if (!pending || (await waitForCreation(pending, signal)) !== paneKey) {
        return 'failed'
      }
    }
    if (signal.aborted || !runtime.hasLiveTerminalForPaneKey(paneKey)) {
      return 'failed'
    }
    const handle = runtime.getTerminalHandleForPaneKey(paneKey)
    if (!handle || runtime.getTerminalWorktreeIdForHandle(handle) !== request.worktreeId) {
      return 'failed'
    }
    try {
      await runtime.focusTerminal(handle, { navigateHost: true })
    } catch {
      return 'failed'
    }
    const owner = server.findJcodeSessionOwner(request.sessionId)
    return !signal.aborted && owner?.paneKey === paneKey && owner.state === 'open'
      ? 'done'
      : 'failed'
  }

  return async (request, signal) => {
    if (
      !deps.verifyJcodePaneSecret(request.paneKey, request.paneSecret) ||
      !runtime.hasLiveTerminalForPaneKey(request.paneKey)
    ) {
      return 'forbidden'
    }
    const rootHandle = runtime.getTerminalHandleForPaneKey(request.paneKey)
    const worktreeId = rootHandle ? runtime.getTerminalWorktreeIdForHandle(rootHandle) : null
    const jcodeRuntimeDir = shouldInjectJcodeRuntimeDir(process.platform)
      ? buildJcodeRuntimeDir(request.paneKey)
      : undefined
    if (
      !worktreeId ||
      request.worktreeId !== worktreeId ||
      (jcodeRuntimeDir !== undefined && request.runtimeDir !== jcodeRuntimeDir)
    ) {
      return 'forbidden'
    }
    if (signal.aborted) {
      return 'failed'
    }
    const decision = decideJcodeSpawn(request, {
      rootSessionId: server.rootJcodeSessionId(request.paneKey),
      owner: server.findJcodeSessionOwner(request.sessionId)
    })
    if (decision.action === 'focus') {
      return focus(request, decision.paneKey, decision.waitForCreation, signal)
    }
    const { tabId, leafId, paneKey } = allocateTerminalPaneIdentity({})
    let kind: 'worker' | 'plain' = decision.action === 'open-child' ? 'worker' : 'plain'
    const reserve = () =>
      server.reserveJcodeSessionTab({
        sessionId: request.sessionId,
        paneKey,
        kind,
        rootPaneKey: request.paneKey
      })
    let reservation = reserve()
    if (!reservation.ok) {
      return reservation.owner.state === 'closed'
        ? 'failed'
        : focus(request, reservation.owner.paneKey, reservation.owner.state === 'creating', signal)
    }
    if (kind === 'worker') {
      const bound =
        request.coordinatorSessionId !== undefined &&
        server.bindJcodeDisplaySession({
          rootPaneKey: request.paneKey,
          displayPaneKey: paneKey,
          sessionId: request.sessionId,
          coordinatorSessionId: request.coordinatorSessionId,
          tabId,
          worktreeId,
          // Raw commands have no launchConfig, so the runtime cannot retain a launch token.
          launchToken: undefined,
          state: 'open',
          boundAt: Date.now()
        })
      if (bound) {
        runtime.setExternalAgentParentLink(paneKey, {
          parentPaneKey: request.paneKey,
          taskId: `jcode-spawn:${request.sessionId}`,
          displayName:
            request.title?.match(/jcode\/\S+\s+(.+?)(?:\s+·.*)?$/u)?.[1]?.trim() || undefined
        })
      } else {
        server.releaseJcodeSessionTab(request.sessionId, paneKey)
        kind = 'plain'
        reservation = reserve()
        if (!reservation.ok) {
          return reservation.owner.state === 'closed'
            ? 'failed'
            : focus(
                request,
                reservation.owner.paneKey,
                reservation.owner.state === 'creating',
                signal
              )
        }
      }
    }
    let finishCreation!: (paneKey: string | null) => void
    const pending = new Promise<string | null>((resolve) => {
      finishCreation = resolve
    })
    inFlight.set(request.sessionId, pending)
    const finish = (key: string | null) => {
      if (inFlight.get(request.sessionId) === pending) {
        inFlight.delete(request.sessionId)
      }
      finishCreation(key)
    }
    const attempt: { cancelled: boolean; handle?: string; closed: boolean } = {
      cancelled: false,
      closed: false
    }
    let rolledBack = false
    const rollback = () => {
      if (rolledBack) {
        return
      }
      rolledBack = true
      bestEffortJcodeCleanup('settle display binding', () => server.settleJcodeDisplayPane(paneKey))
      bestEffortJcodeCleanup('release session owner', () =>
        server.releaseJcodeSessionTab(request.sessionId, paneKey)
      )
      bestEffortJcodeCleanup('clear parent link', () =>
        runtime.clearExternalAgentParentLink(paneKey)
      )
      bestEffortJcodeCleanup('clear pane state', () => server.clearPaneState(paneKey))
    }
    const close = () => {
      if (attempt.handle && !attempt.closed) {
        attempt.closed = true
        const handle = attempt.handle
        bestEffortJcodeCleanup('close terminal', () => runtime.closeTerminalTab(handle))
      }
    }
    return new Promise<JcodeSpawnOutcome>((resolve) => {
      const settle = (outcome: JcodeSpawnOutcome) => {
        signal.removeEventListener('abort', abort)
        resolve(outcome)
      }
      const abort = () => {
        attempt.cancelled = true
        rollback()
        close()
        finish(null)
        settle('failed')
      }
      signal.addEventListener('abort', abort, { once: true })
      const create = async () => {
        let cwd = request.cwd
        if (kind === 'worker' && cwd) {
          // workers stay within their worktree; plain tabs preserve upstream's unconstrained caller cwd.
          const workspace = await runtime.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
          const resolved = resolveTerminalStartupCwd(workspace.path, cwd)
          cwd = resolved && isPathInsideOrEqual(workspace.path, resolved) ? resolved : undefined
        }
        if (attempt.cancelled || !deps.verifyJcodePaneSecret(request.paneKey, request.paneSecret)) {
          return null
        }
        return runtime.createTerminal(`id:${worktreeId}`, {
          command: request.command,
          cwd,
          title: request.title,
          // plain tabs also run same-daemon commands and must reach the root's daemon.
          jcodeRuntimeDir,
          surfaceOwner: false,
          tabId,
          leafId,
          signal
        })
      }
      void create()
        .then((terminal) => {
          if (terminal) {
            attempt.handle = terminal.handle
          }
          if (
            !terminal ||
            attempt.cancelled ||
            signal.aborted ||
            !deps.verifyJcodePaneSecret(request.paneKey, request.paneSecret) ||
            !server.confirmJcodeSessionTab(request.sessionId, paneKey)
          ) {
            close()
            rollback()
            finish(null)
            settle('failed')
            return
          }
          finish(paneKey)
          settle('done')
        })
        .catch(() => {
          close()
          rollback()
          finish(null)
          settle('failed')
        })
    })
  }
}

let unregisterPaneTeardown: (() => void) | undefined

export function registerJcodeSpawnOwner(
  runtime: JcodeSpawnHandlerDeps['runtime'],
  isQuitting: () => boolean
): void {
  agentHookServer.setJcodeSpawnListener(
    createJcodeSpawnHandler({ runtime, server: agentHookServer, verifyJcodePaneSecret })
  )
  unregisterPaneTeardown?.()
  unregisterPaneTeardown = registerPaneKeyTeardownListener((paneKey) =>
    retireJcodePane(
      { runtime, server: agentHookServer, forgetJcodePaneSecret, isQuitting },
      paneKey
    )
  )
}
