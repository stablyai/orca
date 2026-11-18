import type { TraexAppServerConnection } from './traex-app-server-connection'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentChatPermissionChoice } from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { traexRecord } from './traex-protocol'

const SETUP_TIMEOUT_MS = 60_000

/** Windows commands run inside the CLI's sandbox only after the host sets it up. */
export class TraexWindowsSandbox {
  private pending: {
    requestId: number
    resolve: (ready: boolean) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(
    private readonly connection: TraexAppServerConnection,
    private readonly sessionId: string,
    private readonly logger?: StructuredAgentSessionLogger
  ) {}

  async prepare(cwd: string, permissionMode: AgentChatPermissionChoice): Promise<boolean> {
    if (
      process.platform !== 'win32' ||
      permissionMode === 'own' ||
      permissionMode === 'full-access'
    ) {
      return true
    }
    if (this.connection.closed) {
      return false
    }
    let requestId: number | null = null
    const ready = Promise.withResolvers<boolean>()
    try {
      const started = traexRecord(
        await this.connection.request(
          'windowsSandbox/setupStart',
          { mode: 'unelevated', cwd },
          {
            onRequestId: (id) => {
              requestId = id
              const timer = setTimeout(() => this.settle(id, false), SETUP_TIMEOUT_MS)
              timer.unref()
              this.pending = { requestId: id, resolve: ready.resolve, timer }
            }
          }
        )
      ).started
      if (started !== true && requestId !== null) {
        this.settle(requestId, false)
      }
      const prepared = await ready.promise
      if (!prepared) {
        this.logger?.warn('TRAE CLI Windows sandbox was not established', {
          scope: 'traex-sandbox',
          sessionId: this.sessionId
        })
      }
      return prepared
    } catch (error) {
      if (requestId !== null) {
        this.settle(requestId, false)
      }
      this.logger?.warn('TRAE CLI Windows sandbox setup failed', {
        scope: 'traex-sandbox',
        sessionId: this.sessionId,
        error
      })
      return false
    }
  }

  completed(requestId: unknown, success: boolean, error: string | null): void {
    const pending = this.pending
    if (!pending || requestId !== pending.requestId) {
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

  private settle(requestId: number, ready: boolean): void {
    const pending = this.pending
    if (!pending || pending.requestId !== requestId) {
      return
    }
    this.pending = null
    clearTimeout(pending.timer)
    pending.resolve(ready)
  }
}
