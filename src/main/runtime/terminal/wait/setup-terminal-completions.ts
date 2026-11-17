import type { SetupWorkspaceAttempt as WorkspaceAttempt } from './setup-workspace-attempt'
import { SetupTerminalDependents } from './setup-terminal-dependents'
import type { TerminalSetupVerdict } from '../../../../shared/terminal/pty/lifecycle/terminal-setup-status'
import type { SetupAttemptRecipe } from '../../../../shared/agent-launch/startup/setup-attempt-recipe'
import { mintPtySessionId } from '../../../daemon/sessions/pty-session-id'
import type { TerminalCreateOptions } from '../launch/terminal-create-options'
import { DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { createSetupCompletionScanner } from '../../orchestration/workers/launch/setup-completion-signal'

type SetupCompletion = { exitCode: number | null }

type Attempt = {
  handle: string
  scan: (data: string) => void
  completion: Promise<SetupCompletion>
  finish: (exitCode: number | null) => void
  refuse?: () => void
}

export class SetupTerminalCompletions extends SetupTerminalDependents {
  private readonly attempts = new Map<string, Attempt>()
  private readonly requiredByWorkspace = new Map<string, WorkspaceAttempt>()
  private readonly activeByWorkspace = new Map<string, Set<WorkspaceAttempt>>()
  private readonly byHandle = new Map<string, Attempt>()

  constructor(
    changed: (ptyId: string, verdict: TerminalSetupVerdict) => void = () => {},
    private readonly publishFailure: (
      recipe: SetupAttemptRecipe,
      signal: AbortSignal
    ) => Promise<void> = async () => {}
  ) {
    super(changed)
  }

  capture(workspaceId: string, handle: string, options: TerminalCreateOptions) {
    const token = options.setupCompletionToken
    if (!token) {
      return undefined
    }
    const ptyId = options.sessionId ?? mintPtySessionId(workspaceId)
    const workspace = options.setupRequired ? this.claimWriter(workspaceId, token) : undefined
    const reservation = Symbol()
    workspace?.reservations.add(reservation)
    let started: Attempt | undefined
    return {
      spawnOptions: { sessionId: ptyId, isNewSession: true },
      begin: () => {
        if (workspace && !this.isTracked(workspaceId, workspace)) {
          throw new Error('Setup was canceled. Try Setup again.')
        }
        started ??= this.registerWriter(ptyId, handle, token, workspaceId, workspace)
        workspace?.reservations.delete(reservation)
      },
      finish: (spawned: boolean) => {
        workspace?.reservations.delete(reservation)
        if (!spawned && started && this.attempts.get(ptyId) === started) {
          this.exit(ptyId, true)
          this.forget(ptyId)
        } else if (
          !started &&
          workspace &&
          !workspace.writers.size &&
          !workspace.reservations.size
        ) {
          workspace.finish(null)
        }
      }
    }
  }

  begin(ptyId: string, handle: string, token: string, workspaceId?: string): void {
    this.registerWriter(
      ptyId,
      handle,
      token,
      workspaceId,
      workspaceId ? this.claimWriter(workspaceId, token) : undefined
    )
  }

  private registerWriter(
    ptyId: string,
    handle: string,
    token: string,
    workspaceId?: string,
    workspace?: WorkspaceAttempt
  ): Attempt {
    this.forget(ptyId)
    const answer = Promise.withResolvers<SetupCompletion>()
    let finishWorkspace: ((exitCode: number | null) => void) | undefined
    const finish = (exitCode: number | null): void => {
      finishWorkspace?.(exitCode)
      answer.resolve({ exitCode })
    }
    const scanner = createSetupCompletionScanner(token, finish)
    const attempt: Attempt = { handle, scan: scanner.scan, completion: answer.promise, finish }
    this.attempts.set(ptyId, attempt)
    this.byHandle.set(handle, attempt)
    if (workspace && workspaceId) {
      const captured = workspace
      captured.writers.add(attempt)
      attempt.refuse = () => {
        const { cancelled, result, recipe, publication } = captured
        if (
          cancelled ||
          result?.exitCode != null ||
          !recipe ||
          publication ||
          captured.writers.size > 1 ||
          captured.reservations.size > 0
        ) {
          return
        }
        const abort = new AbortController()
        captured.publication = abort
        void this.publishFailure(recipe, AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]))
          .catch(() => {})
          .finally(() => this.retireWorkspaceAttempt(workspaceId, captured))
      }
      finishWorkspace = (exitCode) => {
        captured.writers.delete(attempt)
        if (exitCode !== null || (!captured.writers.size && !captured.reservations.size)) {
          captured.finish(exitCode)
        }
      }
    }
    return attempt
  }

  private isTracked(workspaceId: string, attempt: WorkspaceAttempt): boolean {
    return (
      this.requiredByWorkspace.get(workspaceId) === attempt ||
      this.activeByWorkspace.get(workspaceId)?.has(attempt) === true
    )
  }

  private claimWriter(workspaceId: string, token: string): WorkspaceAttempt {
    const current = this.requiredByWorkspace.get(workspaceId)
    let workspace = [current, ...(this.activeByWorkspace.get(workspaceId) ?? [])].find(
      (attempt) => attempt && (attempt.writerToken === token || attempt.recipe?.nonce === token)
    )
    if (!workspace) {
      workspace =
        current && !current.bound && !current.result && !current.recipe
          ? current
          : this.beginWorkspace(workspaceId, !current)
    }
    workspace.bound = true
    workspace.writerToken = token
    return workspace
  }

  bindRecipe(workspaceId: string, recipe: SetupAttemptRecipe): () => void {
    let workspace = this.requiredByWorkspace.get(workspaceId)
    if (
      !workspace ||
      (workspace.bound && !workspace.recipe && workspace.writerToken !== recipe.nonce) ||
      (workspace.recipe && workspace.recipe.nonce !== recipe.nonce) ||
      (workspace.result && !workspace.recipe)
    ) {
      workspace = this.beginWorkspace(workspaceId)
    }
    workspace.recipe ??= recipe
    workspace.publish()
    const captured = workspace
    return () => {
      if (!captured.cancelled && this.isTracked(workspaceId, captured)) {
        captured.finish(null)
      }
    }
  }

  async gate(workspaceId: string): Promise<WorkspaceAttempt | undefined> {
    const workspace = this.requiredByWorkspace.get(workspaceId)
    if (workspace && !workspace.recipe && !workspace.result) {
      await workspace.available
    }
    return workspace
  }

  forWorkspace(workspaceId: string): Promise<SetupCompletion> | undefined {
    return this.requiredByWorkspace.get(workspaceId)?.completion
  }

  beginWorkspace(workspaceId: string, makeCurrent = true): WorkspaceAttempt {
    const answer = Promise.withResolvers<SetupCompletion>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const available = Promise.withResolvers<void>()
    const workspace: WorkspaceAttempt = {
      available: available.promise,
      publish: () => available.resolve(),
      completion: answer.promise,
      bound: false,
      cancelled: false,
      reservations: new Set(),
      writers: new Set(),
      cancel: () => {
        workspace.cancelled = true
        workspace.publication?.abort()
        clearTimeout(timer)
      },
      finish: (exitCode) => {
        if (workspace.result) {
          if (exitCode !== null && workspace.result.exitCode === null) {
            workspace.result = { exitCode }
            if (!workspace.publication) {
              this.retireWorkspaceAttempt(workspaceId, workspace)
            }
          }
          return
        }
        workspace.result = { exitCode }
        workspace.publish()
        if (exitCode !== null) {
          clearTimeout(timer)
        }
        answer.resolve({ exitCode })
        if (exitCode !== null && !workspace.publication) {
          this.retireWorkspaceAttempt(workspaceId, workspace)
        }
      }
    }
    timer = setTimeout(() => {
      workspace.finish(null)
      this.retireWorkspaceAttempt(workspaceId, workspace)
    }, DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS * 1000)
    timer.unref()
    if (makeCurrent) {
      this.requiredByWorkspace.set(workspaceId, workspace)
    }
    let active = this.activeByWorkspace.get(workspaceId)
    if (!active) {
      active = new Set()
      this.activeByWorkspace.set(workspaceId, active)
    }
    active.add(workspace)
    return workspace
  }

  preparedWorkspace(
    workspaceId: string,
    required: boolean,
    inProcess = false
  ): (success: boolean) => void {
    let workspace = this.requiredByWorkspace.get(workspaceId)
    if (!workspace || (inProcess && (workspace.bound || workspace.result || workspace.recipe))) {
      workspace = this.beginWorkspace(workspaceId)
    }
    if (inProcess) {
      workspace.bound = true
    }
    const captured = workspace
    if (!required) {
      workspace.finish(0)
    }
    return (success) => {
      if (!captured.cancelled) {
        captured.finish(success ? 0 : null)
      }
    }
  }

  refuseWorkspace(workspaceId: string): void {
    const workspace = this.requiredByWorkspace.get(workspaceId) ?? this.beginWorkspace(workspaceId)
    workspace.finish(null)
  }

  forgetWorkspace(workspaceId: string): void {
    this.forgetWorkspaceDependents(workspaceId)
    for (const attempt of this.activeByWorkspace.get(workspaceId) ?? []) {
      attempt.cancel()
      attempt.finish(null)
    }
    this.activeByWorkspace.delete(workspaceId)
    this.requiredByWorkspace.delete(workspaceId)
  }

  isWriter(ptyId: string | undefined): boolean {
    return ptyId !== undefined && this.attempts.has(ptyId)
  }

  observe(ptyId: string, data: string): void {
    this.attempts.get(ptyId)?.scan(data)
  }

  exit(ptyId: string, confirmed = false): void {
    this.endDependent(ptyId)
    if (confirmed) {
      this.attempts.get(ptyId)?.refuse?.()
    }
    this.attempts.get(ptyId)?.finish(null)
  }

  private retireWorkspaceAttempt(workspaceId: string, attempt: WorkspaceAttempt): void {
    attempt.cancel()
    const active = this.activeByWorkspace.get(workspaceId)
    active?.delete(attempt)
    if (active?.size === 0) {
      this.activeByWorkspace.delete(workspaceId)
    }
  }

  forHandle(handle: string): Promise<SetupCompletion> | undefined {
    return this.byHandle.get(handle)?.completion
  }

  forget(ptyId: string): void {
    this.forgetDependent(ptyId)
    const attempt = this.attempts.get(ptyId)
    if (!attempt) {
      return
    }
    attempt.finish(null)
    this.attempts.delete(ptyId)
    if (this.byHandle.get(attempt.handle) === attempt) {
      this.byHandle.delete(attempt.handle)
    }
  }
}
