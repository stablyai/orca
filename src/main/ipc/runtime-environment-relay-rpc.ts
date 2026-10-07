import { randomBytes } from 'node:crypto'
import { parseRemoteRuntimeRpcFrame } from '../../shared/remote-runtime-request-frames'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

const DEFAULT_RELAY_RPC_TIMEOUT_MS = 15_000

type PendingRelayRpc = {
  resolve: (response: RuntimeRpcResponse<unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Requests Orca itself makes over a Relay link, kept apart from the bridged client's ids. */
export class RuntimeRelayLinkRpc {
  private readonly pending = new Map<string, PendingRelayRpc>()
  private readonly idPrefix = `relay-link-${randomBytes(6).toString('hex')}-`
  private sequence = 0

  constructor(
    private readonly send: (plaintext: string) => boolean,
    private readonly deviceToken: string
  ) {}

  request(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_RELAY_RPC_TIMEOUT_MS
  ): Promise<RuntimeRpcResponse<unknown>> {
    const id = `${this.idPrefix}${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Orca Relay request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const sent = this.send(JSON.stringify({ id, deviceToken: this.deviceToken, method, params }))
      if (!sent) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('Orca Relay link is not ready'))
      }
    })
  }

  /** True when `plaintext` answered one of this helper's requests. */
  handleText(plaintext: string): boolean {
    if (this.pending.size === 0 || !plaintext.includes(this.idPrefix)) {
      return false
    }
    const frame = parseRemoteRuntimeRpcFrame(plaintext)
    if (frame.type !== 'response') {
      return false
    }
    const request = this.pending.get(frame.response.id)
    if (!request) {
      return false
    }
    clearTimeout(request.timer)
    this.pending.delete(frame.response.id)
    request.resolve(frame.response)
    return true
  }

  rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}
