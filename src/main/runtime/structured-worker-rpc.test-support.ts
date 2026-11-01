import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { OrchestrationDb } from './orchestration/db'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { eraseRpcMethods } from './rpc/core'

type Db = InstanceType<typeof OrchestrationDb>
type Runtime = InstanceType<typeof OrcaRuntimeService>

/** A real runtime over `db` with the orchestration RPCs, as a coordinator calls them. */
export function rpcRuntime(db: Db): {
  runtime: Runtime
  call: (name: string, params: Record<string, unknown>) => Promise<unknown>
} {
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  return {
    runtime,
    call: async (name, params) => {
      const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
        (candidate) => candidate.name === name
      )
      if (!method?.params) {
        throw new Error(`Method not found: ${name}`)
      }
      return method.handler(method.params.parse(params), { runtime })
    }
  }
}
