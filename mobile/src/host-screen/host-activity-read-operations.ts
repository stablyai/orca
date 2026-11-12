import { defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import {
  AgentActivityReadSnapshotSchema,
  AgentActivityReadStateSchema
} from '../../../src/shared/rpc-contract/agent-activity-read-params'

export const activityReadSnapshot = defineRpcOperation({
  name: 'ui.agent-activity-read-state',
  method: 'ui.getAgentActivityReadState',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('activity-read-state', AgentActivityReadSnapshotSchema)
})

export const activityReadWrite = defineRpcOperation({
  name: 'ui.set-agent-activity-read-state',
  method: 'ui.setAgentActivityReadState',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('activity-read-written', AgentActivityReadStateSchema)
})
