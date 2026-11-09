import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import type { RuntimeCall } from './hosted-agent-auto-resume'

/** Agent resume after a rollover talks to the environment's orcad over its existing pairing. */
export function createHostedRuntimeEnvironmentCall(
  userDataPath: string,
  environmentId: string
): RuntimeCall {
  return async (method, params = {}) => {
    const response = await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      method,
      params,
      600_000
    )
    if (response.ok === true) {
      return response.result
    }
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
}
