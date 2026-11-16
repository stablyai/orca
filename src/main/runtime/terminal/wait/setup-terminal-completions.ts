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
  settled: boolean
  recipe?: SetupAttemptRecipe
  available: Promise<void>
  publish: () => void
}

type Attempt = {
  handle: string
  scan: (data: string) => void
  completion: Promise<SetupCompletion>
  finish: (exitCode: number | null) => void
}

/** Capture before dispatch; the outcome lives with the PTY record, independently of its output. */
export class SetupTerminalCompletions {
  private readonly attempts = new Map<string, Attempt>()
  private readonly requiredByWorkspace = new Map<string, WorkspaceAttempt>()
  private readonly dependents = new Map<
    string,
    { workspaceId: string; completion: Promise<SetupCompletion>; cancel: () => void }
  >()
  private readonly activeByWorkspace = new Map<string, Set<WorkspaceAttempt>>()
  private readonly dependentIdsByWorkspace = new Map<string, Set<string>>()
  private readonly byHandle = new Map<string, Attempt>()

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
          this.forget(ptyId)
        }
      }
    }
  }

  begin(ptyId: string, handle: string, token: string, workspaceId?: string): void {
    this.forget(ptyId)
    const answer = Promise.withResolvers<SetupCompletion>()
    const finish = (exitCode: number | null): void => answer.resolve({ exitCode })
    const scanner = createSetupCompletionScanner(token, finish)
    const attempt = { handle, scan: scanner.scan, completion: answer.promise, finish }
    this.attempts.set(ptyId, attempt)
    this.byHandle.set(handle, attempt)
    if (workspaceId) {
      let workspace = this.requiredByWorkspace.get(workspaceId)
      if (!workspace || workspace.bound || workspace.settled) {
        this.beginWorkspace(workspaceId)
        workspace = this.requiredByWorkspace.get(workspaceId)!
      }
      workspace.bound = true
      void answer.promise.then(({ exitCode }) => workspace.finish(exitCode))
    }
  }

  bindRecipe(workspaceId: string, recipe: SetupAttemptRecipe): void {
    let workspace = this.requiredByWorkspace.get(workspaceId)
    if (
      !workspace ||
      (workspace.recipe && workspace.recipe.nonce !== recipe.nonce) ||
      (workspace.settled && !workspace.recipe)
    ) {
      this.beginWorkspace(workspaceId)
      workspace = this.requiredByWorkspace.get(workspaceId)!
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
    const dependent = {
      workspaceId,
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
    this.dependents.delete(ptyId)
    const ids = this.dependentIdsByWorkspace.get(dependent.workspaceId)
    ids?.delete(ptyId)
    if (ids?.size === 0) {
      this.dependentIdsByWorkspace.delete(dependent.workspaceId)
    }
  }

  async gate(workspaceId: string): Promise<WorkspaceAttempt | undefined> {
    const workspace = this.requiredByWorkspace.get(workspaceId)
    if (workspace && !workspace.recipe && !workspace.settled) {
      await workspace.available
    }
    return workspace
  }

  forWorkspace(workspaceId: string): Promise<SetupCompletion> | undefined {
    return this.requiredByWorkspace.get(workspaceId)?.completion
  }

  beginWorkspace(workspaceId: string): void {
    const answer = Promise.withResolvers<SetupCompletion>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const available = Promise.withResolvers<void>()
    const workspace: WorkspaceAttempt = {
      available: available.promise,
      publish: () => available.resolve(),
      completion: answer.promise,
      bound: false,
      settled: false,
      finish: (exitCode) => {
        if (workspace.settled) {
          return
        }
        workspace.settled = true
        workspace.publish()
        clearTimeout(timer)
        answer.resolve({ exitCode })
        const active = this.activeByWorkspace.get(workspaceId)
        active?.delete(workspace)
        if (active?.size === 0) {
          this.activeByWorkspace.delete(workspaceId)
        }
      }
    }
    timer = setTimeout(() => workspace.finish(null), DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS * 1000)
    timer.unref()
    this.requiredByWorkspace.set(workspaceId, workspace)
    let active = this.activeByWorkspace.get(workspaceId)
    if (!active) {
      active = new Set()
      this.activeByWorkspace.set(workspaceId, active)
    }
    active.add(workspace)
  }

  preparedWorkspace(workspaceId: string, required: boolean): void {
    if (!this.requiredByWorkspace.has(workspaceId)) {
      this.beginWorkspace(workspaceId)
    }
    if (!required) {
      this.requiredByWorkspace.get(workspaceId)!.finish(0)
    }
  }

  refuseWorkspace(workspaceId: string): void {
    if (!this.requiredByWorkspace.has(workspaceId)) {
      this.beginWorkspace(workspaceId)
    }
    this.requiredByWorkspace.get(workspaceId)!.finish(null)
  }

  forgetWorkspace(workspaceId: string): void {
    for (const id of this.dependentIdsByWorkspace.get(workspaceId) ?? []) {
      this.dependents.get(id)?.cancel()
      this.dependents.delete(id)
    }
    this.dependentIdsByWorkspace.delete(workspaceId)
    for (const attempt of this.activeByWorkspace.get(workspaceId) ?? []) {
      attempt.finish(null)
    }
    this.requiredByWorkspace.delete(workspaceId)
  }

  isWriter(ptyId: string | undefined): boolean {
    return ptyId !== undefined && this.attempts.has(ptyId)
  }

  observe(ptyId: string, data: string): void {
    this.attempts.get(ptyId)?.scan(data)
  }

  exit(ptyId: string): void {
    this.forgetDependent(ptyId)
    this.attempts.get(ptyId)?.finish(null)
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
