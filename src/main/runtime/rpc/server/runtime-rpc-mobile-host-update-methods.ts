/** Updates to the software on the computer itself, run where it is installed; spread into the
 *  execution-host routes. */
export const MOBILE_HOST_UPDATE_RPC_METHODS = [
  // Edit computer's agent CLI rows; gated on agent-cli-update.mobile.v1. A run joins one already going.
  'agentCliUpdate.check',
  'agentCliUpdate.run'
] as const
