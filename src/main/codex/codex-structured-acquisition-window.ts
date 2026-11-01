import type { CodexAcquisitionAttempt } from './codex-structured-session-state'
import { CodexAppliedSettings } from './codex-structured-applied-settings'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'

export class CodexAcquisitionWindow {
  readonly appliedSettings = new CodexAppliedSettings()
  readonly prompts = new CodexPromptRegistry()
  /** Null until the spawn resolves; the handshake can already emit events. */
  connection: CodexAppServerConnection | null = null
  private readonly buffered: (() => void)[] = []
  private state: 'buffering' | 'published' | 'retired' = 'buffering'

  get isRetired(): boolean {
    return this.state === 'retired'
  }

  buffer(event: () => void): boolean {
    if (this.state === 'retired') {
      event()
      return true
    }
    if (this.state === 'published') {
      return false
    }
    // Initialization replies must remain readable; retained output transfers on publish or exit.
    this.buffered.push(event)
    return true
  }

  retire(): void {
    this.state = 'retired'
    for (const event of this.buffered.splice(0)) {
      event()
    }
  }

  drain(): (() => void)[] {
    this.state = 'published'
    return this.buffered.splice(0)
  }
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
