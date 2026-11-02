import { performance } from 'node:perf_hooks'
import type { TerminalHost } from './terminal-host'

export class DaemonSessionAttachments {
  private readonly clientIdBySessionId = new Map<string, string>()
  private readonly tokenBySessionId = new Map<string, symbol>()
  private readonly lastInputAtBySessionId = new Map<string, number>()

  constructor(private readonly host: TerminalHost) {}

  attach(sessionId: string, clientId: string, token: symbol): void {
    this.clientIdBySessionId.set(sessionId, clientId)
    this.tokenBySessionId.set(sessionId, token)
  }

  clientIdForSession(sessionId: string): string | undefined {
    return this.clientIdBySessionId.get(sessionId)
  }

  recordInput(sessionId: string): void {
    this.lastInputAtBySessionId.set(sessionId, performance.now())
  }

  lastInputAt(sessionId: string): number | undefined {
    return this.lastInputAtBySessionId.get(sessionId)
  }

  clearInput(sessionId: string): void {
    this.lastInputAtBySessionId.delete(sessionId)
  }

  release(sessionId: string): void {
    this.clientIdBySessionId.delete(sessionId)
    this.tokenBySessionId.delete(sessionId)
    this.lastInputAtBySessionId.delete(sessionId)
  }

  detachSessionForClient(sessionId: string, clientId: string): void {
    if (this.clientIdBySessionId.get(sessionId) !== clientId) {
      return
    }
    const token = this.tokenBySessionId.get(sessionId)
    if (token) {
      this.host.detach(sessionId, token)
    }
    this.clientIdBySessionId.delete(sessionId)
    this.tokenBySessionId.delete(sessionId)
  }

  detachClientSessions(clientId: string): void {
    const attachments: { sessionId: string; token: symbol }[] = []
    for (const [sessionId, attachedClientId] of this.clientIdBySessionId) {
      if (attachedClientId !== clientId) {
        continue
      }
      const token = this.tokenBySessionId.get(sessionId)
      if (token) {
        attachments.push({ sessionId, token })
      }
      this.clientIdBySessionId.delete(sessionId)
      this.tokenBySessionId.delete(sessionId)
    }
    if (attachments.length > 0) {
      this.host.detachClients(attachments)
    }
  }
}
