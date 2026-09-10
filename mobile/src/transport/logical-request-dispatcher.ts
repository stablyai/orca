import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'
import { HOST_UNVERIFIED_MESSAGE, type HostProtocolAdmission } from './host-protocol-admission'
import { LogicalClientCutoverError } from './logical-client-cutover-error'
import { projectMobileRpcRequestParams } from './mobile-rpc-request-projection'

export type LogicalRequestDispatcherContext = {
  admission?: HostProtocolAdmission
  isClosed: () => boolean
  isSuspended: () => boolean
  activeSession: () => RpcClient
  generation: () => number
  /** Run after a status.get answers, so newly admitted subscriptions can attach. */
  onAdmissionObserved: () => void
}

/**
 * The in-flight logical requests of a stable client: each one is fenced to the generation it
 * was written on, and a request the protocol gate has not admitted yet waits for the verdict
 * rather than failing, because a screen's connect effect runs a round trip ahead of it.
 */
export class LogicalRequestDispatcher {
  private readonly pending = new Set<{ reject: (error: Error) => void }>()

  constructor(private readonly context: LogicalRequestDispatcherContext) {}

  send(
    method: string,
    params?: unknown,
    options?: Parameters<RpcClient['sendRequest']>[2]
  ): Promise<RpcResponse> {
    const { admission } = this.context
    if (!admission || admission.allows(method)) {
      return this.write(method, params, options)
    }
    const probed = admission.whenProbed()
    if (!probed) {
      return Promise.reject(new Error(HOST_UNVERIFIED_MESSAGE))
    }
    const waitGeneration = this.context.generation()
    return probed.then(() => {
      if (waitGeneration !== this.context.generation()) {
        throw new LogicalClientCutoverError()
      }
      if (!admission.allows(method)) {
        throw new Error(HOST_UNVERIFIED_MESSAGE)
      }
      return this.write(method, params, options)
    })
  }

  rejectAllForCutover(): void {
    for (const request of this.pending) {
      request.reject(new LogicalClientCutoverError())
    }
    this.pending.clear()
  }

  private write(
    method: string,
    params: unknown,
    options: Parameters<RpcClient['sendRequest']>[2]
  ): Promise<RpcResponse> {
    if (this.context.isClosed()) {
      return Promise.reject(new Error('Client closed'))
    }
    if (this.context.isSuspended()) {
      return Promise.reject(new Error('Client suspended'))
    }
    const { admission } = this.context
    const requestGeneration = this.context.generation()
    const session = this.context.activeSession()
    const isStatusProbe = method === 'status.get' && admission !== undefined
    if (isStatusProbe) {
      admission.beginProbe()
    }
    return new Promise<RpcResponse>((resolve, reject) => {
      const request = { reject }
      this.pending.add(request)
      void session.sendRequest(method, projectMobileRpcRequestParams(method, params), options).then(
        (response) => {
          this.pending.delete(request)
          const current = requestGeneration === this.context.generation()
          if (isStatusProbe && current) {
            admission.endProbe()
          }
          if (this.context.isClosed()) {
            reject(new Error('Client closed'))
          } else if (!current) {
            reject(new LogicalClientCutoverError())
          } else {
            if (isStatusProbe) {
              admission.observe(response)
              this.context.onAdmissionObserved()
            }
            resolve(response)
          }
        },
        (error: unknown) => {
          this.pending.delete(request)
          // Why: a probe that never answered still ends the wait — holding it would stall
          // every caller behind a dead socket instead of failing them now.
          if (isStatusProbe && requestGeneration === this.context.generation()) {
            admission.endProbe()
          }
          reject(error)
        }
      )
    })
  }
}
