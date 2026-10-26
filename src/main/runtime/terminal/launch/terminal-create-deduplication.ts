import { OrcaRuntimeWithCreateAgentSession } from '../../orca-runtime-create-agent-session'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import { WORKTREE_CREATE_RESULT_TTL_MS } from '../../orca-runtime-core'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../../remote-runtime-terminal-create-identity'
import { withTimeoutResult } from '../../runtime-async-boundaries'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from '../../orca-runtime-postlude'
import { inferWorktreeIdFromPtyId } from '../../runtime-worktree-path-identity'
import { getRegisteredSshState } from '../../../ssh/targets/ssh-target-registry'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { resolveWorktreeLaunchHost } from '../../worktree-launch-host-repo'
import type { TuiAgent } from '../../../../shared/tui-agent'

export abstract class OrcaRuntimeWithTerminalCreateDeduplication extends OrcaRuntimeWithCreateAgentSession {
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
          const adopted = await this.reconcileRemoteTerminalCreate(
            workspace.id,
            preAllocatedHandle,
            // Scope SSH inventory to its host: aggregate listings silently omit unreachable relays and could respawn live work.
            workspace.connectionId ?? null
          )
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
    terminalHandle: string,
    // Host-scoped inventory throws for unreachable SSH; aggregate omission cannot prove absence.
    connectionId?: string | null
  ): Promise<RuntimeTerminalCreate | null> {
    if (!this.ptyController?.listProcesses) {
      throw new Error('runtime_unavailable')
    }
    const listed = await withTimeoutResult(
      this.ptyController.listProcesses(
        connectionId === undefined ? undefined : getConnectionExecutionHostId(connectionId)
      ),
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
      title: session.title,
      ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
      ...(session.wslDistro !== undefined
        ? { wslDistro: session.wslDistro, isWsl: session.wslDistro !== null }
        : {})
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

  getPtyExecutionHostMetadata(
    ptyId: string | null
  ): Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform' | 'incarnationId'> {
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
        ...(pty.incarnationId ? { incarnationId: pty.incarnationId } : {}),
        ...(remotePlatform ? { hostPlatform: remotePlatform } : {})
      }
    }
    return {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      ...(pty.incarnationId ? { incarnationId: pty.incarnationId } : {}),
      hostPlatform: pty.isWsl || pty.wslDistro ? 'linux' : process.platform
    }
  }

  async launchAgentTerminal(
    worktreeSelector: string,
    opts: {
      agent: TuiAgent
      prompt: string
      title?: string
      extraAgentArgs?: string
      suppressStartupUpdatePrompt?: boolean
    }
  ): Promise<RuntimeTerminalCreate> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    // Repo ids are host-blind; resolve against the worktree owner before quoting its launch (#11163).
    const resolution = resolveWorktreeLaunchHost(this.store?.getRepos() ?? [], worktree)
    if (resolution.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    const repo = resolution.repo ?? this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('Repository for the selected workspace is no longer available.')
    }
    const startup = this.buildStartupForAgent(repo, opts.agent, opts.prompt, undefined, {
      ...(opts.extraAgentArgs ? { extraAgentArgs: opts.extraAgentArgs } : {}),
      ...(opts.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {}),
      launchScope: await this.resolveTerminalWorkspaceLaunchScope(`id:${worktree.id}`)
    })
    if (startup.launchRuntime instanceof Error) {
      throw startup.launchRuntime
    }
    const terminal = await this.createTerminal(`id:${worktree.id}`, {
      command: startup.startup.command,
      env: startup.startup.env,
      ...(startup.startup.launchConfig ? { launchConfig: startup.startup.launchConfig } : {}),
      launchAgent: startup.agent,
      launchRuntime: startup.launchRuntime,
      startupCommandDelivery: startup.startup.startupCommandDelivery,
      telemetry: startup.startup.telemetry,
      title: opts.title
    })
    // Why: agents that read the prompt after they start get it typed in, not on argv.
    if (startup.followup) {
      this.sendStartupFollowupWhenReady(terminal.handle, startup.followup)
    }
    return terminal
  }

  // Cellular handoff can lose worktree.create responses; join/reuse successes by clientMutationId briefly, and drop failures for fresh retries.
  dedupeWorktreeCreate<T>(
    target: string | { repo: string; repoHostId?: ExecutionHostId },
    clientMutationId: string | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    if (!clientMutationId) {
      return run()
    }
    // Why the host: two creates for one repo id on different hosts are different creates.
    const repoKey =
      typeof target === 'string'
        ? target
        : target.repoHostId
          ? `${target.repoHostId}\0${target.repo}`
          : target.repo
    const key = `${repoKey}\0${clientMutationId}`
    const inflight = this.worktreeCreateByMutationId.get(key)
    if (inflight) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Callers must use one operation/result type per repo and mutation key.
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
