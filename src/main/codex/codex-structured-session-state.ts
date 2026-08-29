import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { cancelProcessAcquisition } from '../../shared/child-process/cancel-process-acquisition'
import type {
  CodexAppServerConnection,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import type { CodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexTurnProcessSnapshot } from './codex-structured-turn-processes'

export type CodexStructuredLaunch = {
  command: string
  args: string[]
  cwd: string
  codexHome: string | null
  resumeThreadId: string | null
  resumePath?: string | null
  env?: Record<string, string>
}

export type CodexStructuredSessionEvent =
  | { type: 'notification'; sessionId: string; threadId: string; method: string; params: unknown }
  | { type: 'server-request'; sessionId: string; threadId: string; method: string; params: unknown }
  | { type: 'provider-frame'; sessionId: string; threadId: string; kind: string; payload: unknown }
  | {
      type: 'prompt'
      sessionId: string
      threadId: string
      method: string
      params: unknown
      codexItemId: string
      promptKey: string
    }
  | { type: 'ended'; sessionId: string; reason: string }

export type CodexStructuredSessionAdapterDeps = {
  resolveLaunch: (input: {
    identity: AgentSessionJournalIdentity
  }) => Promise<CodexStructuredLaunch>
  onEvent?: (event: CodexStructuredSessionEvent) => void
  openConnection?: typeof openCodexAppServerConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
  mintLinkId?: () => string
  now?: () => number
  requestTimeoutMs?: number
  captureTurnProcesses?: (rootPid: number) => Promise<CodexTurnProcessSnapshot | null>
  terminateTurnProcesses?: (
    rootPid: number,
    baseline: CodexTurnProcessSnapshot | null
  ) => Promise<boolean>
}

export type CodexSession = {
  connection: CodexAppServerConnection
  ended: boolean
  threadId: string
  historyPath: string | null
  prompts: CodexAcquisitionWindow['prompts']
  options: Map<string, string>
  reportedOptions: { model?: string; effort?: string }
  turnIdWaiters: ((turnId: string) => void)[]
  translator: CodexJournalTranslator | null
}

export type CodexAcquisitionAttempt = {
  window: CodexAcquisitionWindow
  cancelled: boolean
  exitProven: boolean
  finished: Promise<void>
  finish: () => void
}

export function createCodexAcquisitionAttempt(): CodexAcquisitionAttempt {
  let finish = (): void => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    window: new CodexAcquisitionWindow(),
    cancelled: false,
    exitProven: false,
    finished,
    finish
  }
}

export class CodexAcquisitionRegistry {
  private readonly attempts = new Map<string, CodexAcquisitionAttempt>()
  private closing = false

  get size(): number {
    return this.attempts.size
  }

  start(sessionId: string): {
    previousAttempt: CodexAcquisitionAttempt | undefined
    attempt: CodexAcquisitionAttempt
  } {
    if (this.closing) {
      throw new Error('codex structured session adapter is closing')
    }
    const previousAttempt = this.attempts.get(sessionId)
    const attempt = createCodexAcquisitionAttempt()
    this.attempts.set(sessionId, attempt)
    return { previousAttempt, attempt }
  }

  assertCurrent(sessionId: string, attempt: CodexAcquisitionAttempt): void {
    if (this.closing || attempt.cancelled || this.attempts.get(sessionId) !== attempt) {
      throw new Error(`codex session ${sessionId} was superseded while being acquired`)
    }
  }

  get(sessionId: string): CodexAcquisitionAttempt | undefined {
    return this.attempts.get(sessionId)
  }

  deleteIfCurrent(sessionId: string, attempt: CodexAcquisitionAttempt): void {
    if (this.attempts.get(sessionId) === attempt) {
      this.attempts.delete(sessionId)
    }
  }

  restoreIfCurrent(
    sessionId: string,
    replacement: CodexAcquisitionAttempt,
    previous: CodexAcquisitionAttempt
  ): void {
    if (this.attempts.get(sessionId) === replacement) {
      this.attempts.set(sessionId, previous)
    }
  }

  async closeFailedAttempt(sessionId: string, attempt: CodexAcquisitionAttempt): Promise<boolean> {
    const stopped = (await attempt.window.connection?.close()) ?? true
    if (stopped) {
      attempt.exitProven = true
      this.deleteIfCurrent(sessionId, attempt)
    }
    return stopped
  }

  sessionIds(): IterableIterator<string> {
    return this.attempts.keys()
  }

  close(): void {
    this.closing = true
  }
}

export async function cancelCodexAcquisitionAttempt(
  attempt: CodexAcquisitionAttempt | undefined
): Promise<boolean> {
  if (!attempt) {
    return true
  }
  return cancelProcessAcquisition({
    cancel: () => {
      attempt.cancelled = true
    },
    connection: () => attempt.window.connection,
    exitProven: () => attempt.exitProven,
    finished: attempt.finished
  })
}
