import type { CliStatusResult } from '../../shared/runtime-types'
import { launchOrcaApp } from './launch'
import { getDefaultUserDataPath, readMetadata } from './metadata'
import { getCliStatus } from './status'
import { sendRequest } from './transport'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'

export class RuntimeClient {
  private readonly userDataPath: string
  private readonly requestTimeoutMs: number

  // Why: browser commands trigger first-time session init (agent-browser connect +
  // CDP proxy setup) which can take 15-30s. 60s accommodates cold start without
  // being so large that genuine hangs go unnoticed.
  constructor(userDataPath = getDefaultUserDataPath(), requestTimeoutMs = 60_000) {
    this.userDataPath = userDataPath
    this.requestTimeoutMs = requestTimeoutMs
  }

  async call<TResult>(
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number
    }
  ): Promise<RuntimeRpcSuccess<TResult>> {
    const metadata = readMetadata(this.userDataPath)
    const response = await sendRequest<TResult>(
      metadata,
      method,
      params,
      options?.timeoutMs ?? this.requestTimeoutMs
    )
    if (!response.ok) {
      throw new RuntimeRpcFailureError(response)
    }
    return response
  }

  async getCliStatus(): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    return getCliStatus(this.userDataPath)
  }

  async openOrca(timeoutMs = 15_000): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    const initial = await this.getCliStatus()
    if (initial.result.runtime.reachable) {
      return initial
    }

    launchOrcaApp()
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.getCliStatus()
      if (status.result.runtime.reachable) {
        return status
      }
      await delay(250)
    }

    throw new RuntimeClientError(
      'runtime_open_timeout',
      'Timed out waiting for Orca to start. Run the Orca app manually and try again.'
    )
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
