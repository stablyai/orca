// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateAgentSession } from './orca-runtime-create-agent-session'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { WORKTREE_CREATE_RESULT_TTL_MS } from './orca-runtime-core'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'
import { withTimeoutResult } from './runtime-async-boundaries'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from './orca-runtime-postlude'
import { inferWorktreeIdFromPtyId } from './runtime-worktree-path-identity'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import type { TuiAgent } from '../../shared/tui-agent'

export class OrcaRuntimeWithTerminalCreateDeduplication extends OrcaRuntimeWithCreateAgentSession {
  async dedupeTerminalCreate(
    clientIdentity: string,
    worktreeSelector: string | undefined,
    clientMutationId: string | undefined,
    reconcileExisting: boolean,
    run: (
      canonicalWorktreeSelector: string | undefined,
      preAllocatedHandle: string | undefined
    ) => Promise<RuntimeTerminalCreate>
  ): Promise<RuntimeTerminalCreate> {
    if (!clientMutationId || !worktreeSelector) {
      if (reconcileExisting) {
        throw new Error('runtime_unavailable')
      }
      return await run(worktreeSelector, undefined)
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    const canonicalWorktreeSelector = `id:${workspace.id}`
    const preAllocatedHandle = deriveRemoteRuntimeTerminalCreateHandle(
      clientIdentity,
      workspace.id,
      clientMutationId
    )
    return this.terminalCreateIdempotency.run(
      clientIdentity,
      workspace.id,
      clientMutationId,
      async () => {
        if (reconcileExisting) {
          const adopted = await this.reconcileRemoteTerminalCreate(workspace.id, preAllocatedHandle)
          if (adopted) {
            return adopted
          }
        }
        return await run(canonicalWorktreeSelector, preAllocatedHandle)
      }
    )
  }

  protected async reconcileRemoteTerminalCreate(
    worktreeId: string,
    terminalHandle: string
  ): Promise<RuntimeTerminalCreate | null> {
    if (!this.ptyController?.listProcesses) {
      throw new Error('runtime_unavailable')
    }
    const listed = await withTimeoutResult(
      this.ptyController.listProcesses(),
      PTY_CONTROLLER_LIST_TIMEOUT_MS
    )
    if (!listed.ok) {
      // Why: unknown inventory cannot prove the first create failed, so spawning could duplicate a live shell.
      throw new Error('runtime_unavailable')
    }
    const matches = listed.value.filter((session) => session.terminalHandle === terminalHandle)
    if (matches.length > 1) {
      throw new Error('terminal_create_identity_conflict')
    }
    if (matches.length === 0) {
      const sameWorktreeHasUnknownIdentity = listed.value.some(
        (session) =>
          (session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)) === worktreeId &&
          !session.terminalHandle
      )
      if (sameWorktreeHasUnknownIdentity) {
        // Why: older retained providers may list the first shell without its handle; absence is not authoritative in that shape.
        throw new Error('runtime_unavailable')
      }
      return null
    }
    const session = matches[0]
    const authoritativeWorktreeId = session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)
    if (authoritativeWorktreeId !== worktreeId) {
      // Why: a reused address or forged provider record must never adopt a PTY from another workspace.
      throw new Error('terminal_create_identity_conflict')
    }
    this.adoptControllerTerminalHandle(session.id, terminalHandle)
    const pty = this.recordPtyWorktree(session.id, worktreeId, {
      connected: true,
      title: session.title
    })
    const adoptedHandle = this.issuePtyHandle(pty)
    if (adoptedHandle !== terminalHandle) {
      throw new Error('terminal_create_identity_conflict')
    }
    return {
      handle: adoptedHandle,
      ptyId: session.id,
      worktreeId,
      title: session.title || null,
      surface: 'background'
    }
  }

  protected getPtyExecutionHostMetadata(
    ptyId: string | null
  ): Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform'> {
    if (!ptyId) {
      return {}
    }
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return {}
    }
    if (pty.connectionId) {
      const remotePlatform = getRegisteredSshState(pty.connectionId)?.remotePlatform
      return {
        executionHostId: toSshExecutionHostId(pty.connectionId),
        ...(remotePlatform ? { hostPlatform: remotePlatform } : {})
      }
    }
    return {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      hostPlatform: pty.isWsl || pty.wslDistro ? 'linux' : process.platform
    }
  }

  async launchAgentTerminal(
    worktreeSelector: string,
    opts: { agent: TuiAgent; prompt: string; title?: string }
  ): Promise<RuntimeTerminalCreate> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('Repository for the selected workspace is no longer available.')
    }
    const startup = this.buildStartupForAgent(repo, opts.agent, opts.prompt)
    await this.markWorkspaceTrustedForAgent(opts.agent, repo.connectionId, worktree.path)
    return await this.createTerminal(`id:${worktree.id}`, {
      command: startup.startup.command,
      env: startup.startup.env,
      ...(startup.startup.launchConfig ? { launchConfig: startup.startup.launchConfig } : {}),
      launchAgent: startup.agent,
      startupCommandDelivery: startup.startup.startupCommandDelivery,
      telemetry: startup.startup.telemetry,
      title: opts.title
    })
  }

  // Why: dedupes a worktree.create whose response was lost when a mobile
  // connection migration (relay/direct hand-off on shoddy cellular) rejected the
  // in-flight request. A retry with the same clientMutationId returns the
  // in-flight or just-finished create instead of a duplicate worktree; failures
  // drop immediately so a genuine retry starts fresh, and successes linger
  // briefly so a retry whose response was lost in the cutover still reconciles.
  dedupeWorktreeCreate<T>(
    repoSelector: string,
    clientMutationId: string | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    if (!clientMutationId) {
      return run()
    }
    const key = `${repoSelector}\0${clientMutationId}`
    const inflight = this.worktreeCreateByMutationId.get(key)
    if (inflight) {
      return inflight as Promise<T>
    }
    const created = run()
    this.worktreeCreateByMutationId.set(key, created)
    const drop = (): void => {
      if (this.worktreeCreateByMutationId.get(key) === created) {
        this.worktreeCreateByMutationId.delete(key)
      }
    }
    void created.then(() => {
      setTimeout(drop, WORKTREE_CREATE_RESULT_TTL_MS).unref?.()
    }, drop)
    return created
  }
}
