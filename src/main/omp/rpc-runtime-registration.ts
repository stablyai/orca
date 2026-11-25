import type { StructuredAgentRuntimeRegistration } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { createPiRpcAdapter } from '../pi/rpc-runtime-registration'
import { PI_RPC_FAMILY_OMP } from '../pi/rpc/pi-rpc-family'
import { OMP_RPC_AGENT } from './rpc-agent-definition'
import { OMP_RPC_RUNTIME_METADATA } from './rpc-runtime-metadata'

export const OMP_RPC_RUNTIME_REGISTRATION: StructuredAgentRuntimeRegistration = Object.assign(
  OMP_RPC_RUNTIME_METADATA,
  { createAdapter: (context) => createPiRpcAdapter(context, PI_RPC_FAMILY_OMP, OMP_RPC_AGENT) }
)
