// The shell's answer to a page's shared-agents verb, for the computer the page belongs to.
import { sharedAgentsParamsSchema } from '../../mobile-web-shell/bridge/native-capabilities/bridge-shared-agents-verb'
import type { PhoneSharedAgents } from './phone-shared-agents'

export async function serveSharedAgentsVerb(
  agents: Pick<PhoneSharedAgents, 'ready' | 'find' | 'sendAgain'>,
  pairedHostId: string,
  raw: unknown
): Promise<unknown> {
  const params = sharedAgentsParamsSchema.parse(raw)
  await agents.ready()
  const agent = agents.find(pairedHostId, params.environmentId)
  return { sent: agent ? await agents.sendAgain(agent, params.clientMessageId) : false }
}
