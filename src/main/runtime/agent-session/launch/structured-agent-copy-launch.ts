import { overlayEnvironmentVariables } from '../../../../shared/shell/launch/environment-overlay'
import type { StructuredAgentCopyLaunch } from '../installation/structured-agent-session-runtime-contract'

type ResolveAgentCopyLaunch = (agent: string, copyId: string) => StructuredAgentCopyLaunch | null

/** The launch of the copy a chat runs as, or null for the agent itself. A copy deleted since its
 *  chat began refuses, so the chat never quietly runs as its agent. */
export function agentCopyLaunch(
  resolve: ResolveAgentCopyLaunch | undefined,
  agent: string,
  copyId: string | undefined
): StructuredAgentCopyLaunch | null {
  if (!copyId) {
    return null
  }
  const copy = resolve?.(agent, copyId)
  if (!copy) {
    throw new Error(`Unknown agent copy "${copyId}"`)
  }
  return copy
}

/** A copy's environment: its own variables over the base one, in place of its agent's. */
export function agentCopyEnvironment(
  base: () => Promise<Record<string, string>>,
  copy: Pick<StructuredAgentCopyLaunch, 'launchEnv'>
): () => Promise<Record<string, string>> {
  return async () => overlayEnvironmentVariables(await base(), copy.launchEnv, process.platform)
}
