import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'

// Why: runtime RPC failures resolve as ok:false, but the shared search client
// classifies thrown errors by code, so the refusal has to keep its code to be
// recognised as an old host that lacks the method.
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
