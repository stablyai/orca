import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  requireLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../native-chat/structured-agent-command-resolution'
import { piRpcSessionlessEnvironment } from '../pi/rpc-launch'
import type { PiRpcConnection } from '../pi/rpc-session'
import type { StructuredAgentModelCatalogContext } from '../runtime/structured-agent-runtime-registration-types'
import { openOmpRpcConnection } from './rpc-connection'
import { buildOmpRpcLaunch, resolveOmpRpcInvocation } from './rpc-launch'

export async function runOmpRpcCatalogSession<T>(
  context: StructuredAgentModelCatalogContext,
  account: AgentSessionAccountHome,
  options: {
    kind: 'model' | 'command'
    cwd: string
    operation: StructuredAgentResolutionOperation
    extraArgs?: readonly string[]
  },
  read: (connection: PiRpcConnection) => Promise<T>
): Promise<T> {
  assertStructuredAgentResolutionCurrent(options.operation)
  const { env, command, prefixArgs } = await resolveOmpRpcInvocation({
    accountDir: requireLegacyAgentSessionAccountHome(account).path,
    environment: () => context.environment.resolveAgentEnvironment('omp'),
    settings: context.deps.resolveAgentCommandSettings?.() ?? {},
    cwd: options.cwd,
    operation: options.operation,
    refreshAfterMiss: context.environment.refreshAfterMissingProgram
  })
  const directory = join(context.deps.stateDirectory, 'omp-rpc')
  await mkdir(directory, { recursive: true })
  const scratch = await mkdtemp(join(directory, 'catalog-'))
  try {
    assertStructuredAgentResolutionCurrent(options.operation)
    return await runAgentModelCatalogSession(
      () =>
        openOmpRpcConnection(
          buildOmpRpcLaunch({
            command,
            prefixArgs,
            cwd: options.cwd,
            fullAccess: true,
            ...piRpcSessionlessEnvironment(env),
            extraArgs: [...(options.extraArgs ?? []), '--session-dir', scratch]
          }),
          {}
        ),
      async (connection) => {
        const result = await read(connection)
        assertStructuredAgentResolutionCurrent(options.operation)
        return result
      },
      { label: `OMP RPC ${options.kind} discovery`, signal: options.operation.signal }
    )
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) =>
      context.deps.logger.warn(`OMP ${options.kind} catalog scratch cleanup failed`, {
        scope: `omp-rpc-${options.kind}-catalog`,
        error
      })
    )
  }
}
