import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  ORCHESTRATION_RETAINED_RUN_BINDINGS_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_START_IMPLICIT_RUN_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { resolveOrchestrationCliExecutable } from '../../runtime/orchestration-recovery-command'

async function runtimeLacks(client: RuntimeClient, capability: string): Promise<boolean> {
  const status = await client.call<RuntimeStatus>('status.get')
  return !status.result.capabilities?.includes(capability)
}

/** An older server refuses worker-start without a bound Run; tell the agent instead of creating one. */
export async function explainOlderRuntimeRunRequired(
  client: RuntimeClient,
  error: unknown
): Promise<unknown> {
  if (!(error instanceof RuntimeClientError) || error.code !== 'run_required') {
    return error
  }
  const older = await runtimeLacks(
    client,
    ORCHESTRATION_WORKER_START_IMPLICIT_RUN_RUNTIME_CAPABILITY
  ).catch(() => false)
  return older
    ? new RuntimeClientError(
        'incompatible_runtime',
        `This Orca server is an older version and needs a Run first. Run \`${resolveOrchestrationCliExecutable()} orchestration run-create --objective "<goal>" --json\`, then run this worker-start again.`
      )
    : error
}

/** The Run an older server will unbind from this coordinator when it creates another. */
export async function findRunOlderRuntimeWillUnbind(
  client: RuntimeClient,
  from: string | undefined
): Promise<string | null> {
  if (!(await runtimeLacks(client, ORCHESTRATION_RETAINED_RUN_BINDINGS_RUNTIME_CAPABILITY))) {
    return null
  }
  const current = await client.call<{ run: { id: string } | null }>('orchestration.runCurrent', {
    from
  })
  return current.result.run?.id ?? null
}

export function olderRuntimeUnboundRunNext(runId: string): string {
  return `This Orca server is an older version and keeps one Run per coordinator; ${runId} is no longer bound to you. Switch back with \`${resolveOrchestrationCliExecutable()} orchestration run-use --id ${runId} --json\`.`
}
