import { randomUUID } from 'node:crypto'
import type { TerminalSetupVerdict } from '../../../../shared/terminal/pty/lifecycle/terminal-setup-status'
import type { SetupAttemptRecipe } from '../../../../shared/agent-launch/startup/setup-attempt-recipe'
import { mintPtySessionId } from '../../../daemon/sessions/pty-session-id'
import type { TerminalCreateOptions } from '../launch/terminal-create-options'
import { DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { createSetupCompletionScanner } from '../../orchestration/workers/launch/setup-completion-signal'

type SetupCompletion = { exitCode: number | null }
type WorkspaceAttempt = {
  completion: Promise<SetupCompletion>
  finish: (exitCode: number | null) => void
  bound: boolean
  result?: SetupCompletion
  recipe?: SetupAttemptRecipe
  available: Promise<void>
  publish: () => void
  cancel: () => void
  cancelled: boolean
  publication?: AbortController
}

type Attempt = {
  handle: string
  scan: (data: string) => void
  completion: Promise<SetupCompletion>
  finish: (exitCode: number | null) => void
  refuse?: () => void
}

export class SetupTerminalCompletions {
  private readonly attempts = new Map<string, Attempt>()
  private readonly requiredByWorkspace = new Map<string, WorkspaceAttempt>()
  private readonly dependents = new Map<
    string,
    {
      workspaceId: string
      completion: Promise<SetupCompletion>
      cancel: () => void
      verdict: TerminalSetupVerdict
    }
  >()
  private readonly activeByWorkspace = new Map<string, Set<WorkspaceAttempt>>()
  private readonly dependentIdsByWorkspace = new Map<string, Set<string>>()
  private readonly byHandle = new Map<string, Attempt>()

  constructor(
    private readonly changed: (ptyId: string, verdict: TerminalSetupVerdict) => void = () => {},
    private readonly publishFailure: (
      recipe: SetupAttemptRecipe,
      signal: AbortSignal
    ) => Promise<void> = async () => {}
  ) {}

  status(ptyId: string): TerminalSetupVerdict {
    return this.dependents.get(ptyId)?.verdict ?? { dependencyId: null, state: 'ready' }
  }

  capture(workspaceId: string, handle: string, options: TerminalCreateOptions) {
    const token = options.setupCompletionToken
    if (!token) {
      return undefined
    }
    const ptyId = options.sessionId ?? mintPtySessionId(workspaceId)
    return {
      spawnOptions: { sessionId: ptyId, isNewSession: true },
      begin: () =>
        this.begin(ptyId, handle, token, options.setupRequired ? workspaceId : undefined),
      finish: (spawned: boolean) => {
        if (!spawned) {
          this.exit(ptyId, true)
          this.forget(ptyId)
        }
      }
    }
  }

  begin(ptyId: string, handle: string, token: string, workspaceId?: string): void {
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
    if (workspaceId) {
      let workspace = this.requiredByWorkspace.get(workspaceId)
      if (!workspace || workspace.bound || workspace.result) {
        workspace = this.beginWorkspace(workspaceId)
      }
      workspace.bound = true
      const captured = workspace
      attempt.refuse = () => {
        const { cancelled, result, recipe, publication } = captured
        if (cancelled || result?.exitCode != null || !recipe || publication) {
          return
        }
        const abort = new AbortController()
        captured.publication = abort
        void this.publishFailure(recipe, AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]))
          .catch(() => {})
          .finally(() => this.retireWorkspaceAttempt(workspaceId, captured))
      }
      finishWorkspace = (exitCode) => captured.finish(exitCode)
    }
  }

  bindRecipe(workspaceId: string, recipe: SetupAttemptRecipe): void {
    let workspace = this.requiredByWorkspace.get(workspaceId)
    if (
      !workspace ||
      (workspace.recipe && workspace.recipe.nonce !== recipe.nonce) ||
      (workspace.result && !workspace.recipe)
    ) {
      workspace = this.beginWorkspace(workspaceId)
    }
    workspace.recipe ??= recipe
    workspace.publish()
  }

  bindDependent(
    workspaceId: string,
    ptyId: string,
    completion: Promise<SetupCompletion>
  ): () => void {
    const cancelled = Promise.withResolvers<SetupCompletion>()
    const dependent: {
      workspaceId: string
      verdict: TerminalSetupVerdict
      completion: Promise<SetupCompletion>
      cancel: () => void
    } = {
      workspaceId,
      verdict: { dependencyId: randomUUID(), state: 'pending' } satisfies TerminalSetupVerdict,
      completion: Promise.race([completion, cancelled.promise]),
      cancel: () => cancelled.resolve({ exitCode: null })
    }
    this.forgetDependent(ptyId)
    this.dependents.set(ptyId, dependent)
    let ids = this.dependentIdsByWorkspace.get(workspaceId)
    if (!ids) {
      ids = new Set()
      this.dependentIdsByWorkspace.set(workspaceId, ids)
    }
    ids.add(ptyId)
    void dependent.completion.then(({ exitCode }) => {
      if (this.dependents.get(ptyId) !== dependent || dependent.verdict.state !== 'pending') {
        return
      }
      dependent.verdict = {
        dependencyId: dependent.verdict.dependencyId,
        state: exitCode === 0 ? 'ready' : exitCode === null ? 'unknown' : 'failed'
      }
      this.changed(ptyId, dependent.verdict)
    })
    return () => {
      if (this.dependents.get(ptyId) === dependent) {
        this.forgetDependent(ptyId)
      }
    }
  }

  forDependent(ptyId: string): Promise<SetupCompletion> | undefined {
    return this.dependents.get(ptyId)?.completion
  }

  forgetDependent(ptyId: string): void {
    const dependent = this.dependents.get(ptyId)
    if (!dependent) {
      return
    }
    dependent.cancel()
    this.changed(ptyId, { dependencyId: dependent.verdict.dependencyId, state: 'unknown' })
    this.dependents.delete(ptyId)
    const ids = this.dependentIdsByWorkspace.get(dependent.workspaceId)
    ids?.delete(ptyId)
    if (ids?.size === 0) {
      this.dependentIdsByWorkspace.delete(dependent.workspaceId)
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

  beginWorkspace(workspaceId: string): WorkspaceAttempt {
    const answer = Promise.withResolvers<SetupCompletion>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const available = Promise.withResolvers<void>()
    const workspace: WorkspaceAttempt = {
      available: available.promise,
      publish: () => available.resolve(),
      completion: answer.promise,
      bound: false,
      cancelled: false,
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
    this.requiredByWorkspace.set(workspaceId, workspace)
    let active = this.activeByWorkspace.get(workspaceId)
    if (!active) {
      active = new Set()
      this.activeByWorkspace.set(workspaceId, active)
    }
    active.add(workspace)
    return workspace
  }

  preparedWorkspace(workspaceId: string, required: boolean): void {
    const workspace = this.requiredByWorkspace.get(workspaceId) ?? this.beginWorkspace(workspaceId)
    if (!required) {
      workspace.finish(0)
    }
  }

  refuseWorkspace(workspaceId: string): void {
    const workspace = this.requiredByWorkspace.get(workspaceId) ?? this.beginWorkspace(workspaceId)
    workspace.finish(null)
  }

  forgetWorkspace(workspaceId: string): void {
    for (const id of this.dependentIdsByWorkspace.get(workspaceId) ?? []) {
      const dependent = this.dependents.get(id)
      if (dependent) {
        dependent.verdict = { dependencyId: dependent.verdict.dependencyId, state: 'unknown' }
        dependent.cancel()
        this.changed(id, dependent.verdict)
      }
    }
    this.dependentIdsByWorkspace.delete(workspaceId)
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
    this.forgetDependent(ptyId)
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
