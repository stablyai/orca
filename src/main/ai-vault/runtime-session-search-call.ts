import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'

// Preserve RPC refusal codes so search recognizes older hosts that lack the method.
export async function callRuntimeSessionSearch(
  userDataPath: string,
  environmentId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const response = await callRuntimeEnvironment(userDataPath, environmentId, method, params)
  if (response.ok === true) {
    return response.result
  }
  throw Object.assign(new Error(response.error.message), { code: response.error.code })
}
