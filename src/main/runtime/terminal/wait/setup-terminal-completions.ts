import { DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { createSetupCompletionScanner } from '../../orchestration/workers/launch/setup-completion-signal'

type SetupCompletion = { exitCode: number | null }
type WorkspaceAttempt = {
  completion: Promise<SetupCompletion>
  finish: (exitCode: number | null) => void
  bound: boolean
  settled: boolean
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
  private readonly byHandle = new Map<string, Attempt>()

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

  forWorkspace(workspaceId: string): Promise<SetupCompletion> | undefined {
    return this.requiredByWorkspace.get(workspaceId)?.completion
  }

  beginWorkspace(workspaceId: string): void {
    this.requiredByWorkspace.get(workspaceId)?.finish(null)
    const answer = Promise.withResolvers<SetupCompletion>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const workspace: WorkspaceAttempt = {
      completion: answer.promise,
      bound: false,
      settled: false,
      finish: (exitCode) => {
        workspace.settled = true
        clearTimeout(timer)
        answer.resolve({ exitCode })
      }
    }
    timer = setTimeout(() => workspace.finish(null), DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS * 1000)
    timer.unref()
    this.requiredByWorkspace.set(workspaceId, workspace)
  }

  preparedWorkspace(workspaceId: string, required: boolean): void {
    if (!this.requiredByWorkspace.has(workspaceId)) this.beginWorkspace(workspaceId)
    if (!required) this.requiredByWorkspace.get(workspaceId)!.finish(0)
  }

  refuseWorkspace(workspaceId: string): void {
    if (!this.requiredByWorkspace.has(workspaceId)) this.beginWorkspace(workspaceId)
    this.requiredByWorkspace.get(workspaceId)!.finish(null)
  }

  forgetWorkspace(workspaceId: string): void {
    this.requiredByWorkspace.get(workspaceId)?.finish(null)
    this.requiredByWorkspace.delete(workspaceId)
  }

  observe(ptyId: string, data: string): void {
    this.attempts.get(ptyId)?.scan(data)
  }

  exit(ptyId: string): void {
    this.attempts.get(ptyId)?.finish(null)
  }

  forHandle(handle: string): Promise<SetupCompletion> | undefined {
    return this.byHandle.get(handle)?.completion
  }

  forget(ptyId: string): void {
    const attempt = this.attempts.get(ptyId)
    if (!attempt) return
    attempt.finish(null)
    this.attempts.delete(ptyId)
    if (this.byHandle.get(attempt.handle) === attempt) this.byHandle.delete(attempt.handle)
  }
}
