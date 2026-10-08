import type { RpcContext } from '../core'

/** Legacy clients still use the host seed; new clients explicitly own the options. */
export async function structuredAgentSessionClientCreateSupport(
  runtime: RpcContext['runtime'],
  worktree: string,
  agent: string
) {
  const support = await runtime.getStructuredAgentSessionCreateSupport(worktree, agent)
  const seedOptions = support.supported
    ? runtime.structuredAgentSessionLaunchSeedOptions(agent)
    : undefined
  return support.supported
    ? { ...support, acceptsClientOptions: true, ...(seedOptions ? { seedOptions } : {}) }
    : support
}
