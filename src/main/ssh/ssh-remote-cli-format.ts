import type { CliStatusResult } from '../../shared/runtime-types'
import type { RpcResponse } from '../runtime/rpc/core'
import { formatRemoteLinearCli } from './ssh-remote-linear-output'

export function formatRemoteCli(response: RpcResponse): { stdout: string; stderr: string } {
  if (!response.ok) {
    return { stdout: '', stderr: `${formatRemoteCliError(response.error)}\n` }
  }
  const result = response.result
  if (isRecord(result) && 'app' in result && 'runtime' in result && 'graph' in result) {
    const record = result as Record<string, unknown>
    return formatStatusResult(record as CliStatusResult)
  }
  const linear = formatRemoteLinearCli(result)
  if (linear) {
    return linear
  }
  return { stdout: `${JSON.stringify(result)}\n`, stderr: '' }
}

function formatRemoteCliError(error: { message: string; data?: unknown }): string {
  const nextSteps =
    isRecord(error.data) && Array.isArray(error.data.nextSteps)
      ? error.data.nextSteps.filter((step): step is string => typeof step === 'string')
      : []
  if (nextSteps.length === 0) {
    return error.message
  }
  return `${error.message}\n${nextSteps.map((step) => `Next step: ${step}`).join('\n')}`
}

function formatStatusResult(status: CliStatusResult): { stdout: string; stderr: string } {
  return {
    stdout: `${[
      `appRunning: ${status.app.running}`,
      `pid: ${status.app.pid ?? 'none'}`,
      `runtimeState: ${status.runtime.state}`,
      `runtimeReachable: ${status.runtime.reachable}`,
      `runtimeId: ${status.runtime.runtimeId ?? 'none'}`,
      `graphState: ${status.graph.state}`
    ].join('\n')}\n`,
    stderr: ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}
