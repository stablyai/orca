// The two RPCs Edit computer's agent CLI rows use; both run on the computer whose CLIs they are.
import * as z from 'zod'
import {
  isAgentCliUpdateAgent,
  type AgentCliUpdate,
  type AgentCliUpdateRunResult
} from '../../../../../src/shared/agent-launch/installation/agent-cli-update'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'

const UpdateSchema = z.looseObject({
  agent: z.string(),
  installedVersion: z.string(),
  latestVersion: z.string(),
  command: z.string(),
  runnable: z.boolean(),
  models: z
    .array(z.looseObject({ id: z.string(), name: z.string(), minVersion: z.string() }))
    .optional()
    .catch(undefined)
})

// One malformed or unknown-agent row drops alone, so a newer host's extra agent never hides the rest.
const UpdatesSchema = z.looseObject({ updates: z.array(z.unknown()) }).transform(({ updates }) =>
  updates.flatMap((raw): AgentCliUpdate[] => {
    const parsed = UpdateSchema.safeParse(raw)
    if (!parsed.success || !isAgentCliUpdateAgent(parsed.data.agent)) {
      return []
    }
    const { agent, installedVersion, latestVersion, command, runnable, models } = parsed.data
    return [
      {
        agent,
        installedVersion,
        latestVersion,
        command,
        runnable,
        ...(models ? { models } : {})
      }
    ]
  })
)

const RunResultSchema = z
  .looseObject({ ok: z.boolean(), output: z.string().catch(''), command: z.string().optional() })
  .transform(({ ok, output, command }): AgentCliUpdateRunResult =>
    ok ? { ok: true } : { ok: false, output, ...(command ? { command } : {}) }
  )

export const agentCliUpdatesCheck = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentCliUpdate.check',
    method: 'agentCliUpdate.check',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-cli-updates', UpdatesSchema)
  })
)

export const agentCliUpdateRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentCliUpdate.run',
    method: 'agentCliUpdate.run',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-cli-update-run', RunResultSchema)
  })
)
