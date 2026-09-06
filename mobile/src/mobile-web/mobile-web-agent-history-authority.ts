import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export class MobileWebAgentHistoryAuthority {
  private readonly handleByHostSessionId = new Map<string, string>()
  private readonly hostSessionByHandle = new Map<string, AiVaultSession>()
  private nextHandle = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  synchronize(sessions: readonly AiVaultSession[]): void {
    const retainedSessionIds = new Set(sessions.map((session) => session.id))
    for (const [hostSessionId, handle] of this.handleByHostSessionId) {
      if (!retainedSessionIds.has(hostSessionId)) {
        this.handleByHostSessionId.delete(hostSessionId)
        this.hostSessionByHandle.delete(handle)
      }
    }
    for (const session of sessions) {
      const existingHandle = this.handleByHostSessionId.get(session.id)
      if (existingHandle) {
        this.hostSessionByHandle.set(existingHandle, session)
        continue
      }
      const handle = this.createHandle()
      this.handleByHostSessionId.set(session.id, handle)
      this.hostSessionByHandle.set(handle, session)
    }
  }

  pageHandle(hostSessionId: string): string {
    const handle = this.handleByHostSessionId.get(hostSessionId)
    if (!handle) {
      throw new MobileWebBrokerError('not_found')
    }
    return handle
  }

  hostSession(handle: string): AiVaultSession {
    const session = this.hostSessionByHandle.get(handle)
    if (!session) {
      throw new MobileWebBrokerError('not_found')
    }
    return session
  }

  assertSession(handle: string, expected: AiVaultSession): void {
    if (JSON.stringify(this.hostSession(handle)) !== JSON.stringify(expected)) {
      throw new MobileWebBrokerError('conflict')
    }
  }

  clear(): void {
    this.handleByHostSessionId.clear()
    this.hostSessionByHandle.clear()
  }

  private createHandle(): string {
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const counter = this.nextHandle.toString(36)
    this.nextHandle += 1
    return `agent_session_${counter}_${Array.from(bytes, byteToHex).join('')}`
  }
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
