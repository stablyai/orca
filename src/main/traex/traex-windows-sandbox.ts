import { randomUUID } from 'node:crypto'
import type { TraexAppServerConnection } from './traex-app-server-connection'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentChatPermissionChoice } from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { traexRecord } from './traex-protocol'

const SETUP_TIMEOUT_MS = 60_000

/** Windows commands run inside the CLI's sandbox only after the host sets it up. */
export class TraexWindowsSandbox {
  private pending: {
    requestId: string
    resolve: (ready: boolean) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(
    private readonly connection: TraexAppServerConnection,
    private readonly sessionId: string,
    private readonly logger?: StructuredAgentSessionLogger
  ) {}

  async prepare(cwd: string, permissionMode: AgentChatPermissionChoice): Promise<void> {
    if (
      process.platform !== 'win32' ||
      permissionMode === 'own' ||
      permissionMode === 'full-access' ||
      this.connection.closed
    ) {
      return
    }
    const requestId = randomUUID()
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, false), SETUP_TIMEOUT_MS)
      timer.unref()
      this.pending = { requestId, resolve, timer }
    })
    try {
      const started = traexRecord(
        await this.connection.request('windowsSandbox/setupStart', {
          mode: 'unelevated',
          cwd
        })
      ).started
      if (started !== true) {
        this.settle(requestId, false)
      }
      await ready
    } catch (error) {
      this.settle(requestId, false)
      this.logger?.warn('TRAE CLI Windows sandbox setup failed', {
        scope: 'traex-sandbox',
        sessionId: this.sessionId,
        error
      })
    }
  }

  completed(requestId: unknown, success: boolean, error: string | null): void {
    const pending = this.pending
    if (!pending || String(requestId) !== pending.requestId) {
      return
    }
    this.settle(pending.requestId, success)
    if (!success) {
      this.logger?.warn('TRAE CLI Windows sandbox setup did not complete', {
        scope: 'traex-sandbox',
        sessionId: this.sessionId,
        detail: error
      })
    }
  }

  dispose(): void {
    if (this.pending) {
      this.settle(this.pending.requestId, false)
    }
  }

  private settle(requestId: string, ready: boolean): void {
    const pending = this.pending
    if (!pending || pending.requestId !== requestId) {
      return
    }
    this.pending = null
    clearTimeout(pending.timer)
    pending.resolve(ready)
  }
}
