import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'

const HOSTED_SOURCE_CONTROL_RUNTIME_ID = 'hosted-source-control'

export function hostedSourceControlSuccess(result: unknown): RpcSuccess {
  return {
    id: HOSTED_SOURCE_CONTROL_RUNTIME_ID,
    ok: true,
    result,
    _meta: { runtimeId: HOSTED_SOURCE_CONTROL_RUNTIME_ID }
  }
}

export function hostedSourceControlFailure(
  code: string,
  message = 'Source control action failed'
): RpcFailure {
  return {
    id: HOSTED_SOURCE_CONTROL_RUNTIME_ID,
    ok: false,
    error: { code, message },
    _meta: { runtimeId: HOSTED_SOURCE_CONTROL_RUNTIME_ID }
  }
}

export async function hostedSourceControlResponse(
  request: () => Promise<unknown>
): Promise<RpcResponse> {
  try {
    return hostedSourceControlSuccess(await request())
  } catch {
    return hostedSourceControlFailure('host_error')
  }
}
