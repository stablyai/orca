import { ANTIGRAVITY_NATIVE_CHAT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { hostStatusProbe } from '../transport/host-status-probe-operations'

const READ_ERROR = 'Unable to read Antigravity Chat from the connected host.'
const OLD_HOST = 'Update the connected Orca runtime to use Antigravity Chat.'

type Client = Parameters<typeof hostStatusProbe.request>[0]

export async function requireMobileAntigravityChatCapability(
  client: Client,
  agent: string
): Promise<void> {
  if (agent !== 'antigravity') {
    return
  }
  let supports: boolean
  try {
    const reply = hostStatusProbe.interpret(await hostStatusProbe.request(client))
    if (!reply.accepted || !reply.value) {
      throw new Error(READ_ERROR)
    }
    supports =
      reply.value.capabilities?.includes(ANTIGRAVITY_NATIVE_CHAT_RUNTIME_CAPABILITY) === true
  } catch {
    throw new Error(READ_ERROR)
  }
  if (!supports) {
    throw new Error(OLD_HOST)
  }
}

export function startMobileNativeChatAfterCapability(
  client: Client,
  agent: string,
  start: () => () => void,
  onError: (message: string) => void
): () => void {
  if (agent !== 'antigravity') {
    return start()
  }
  let cancelled = false
  let unsubscribe: (() => void) | undefined
  void requireMobileAntigravityChatCapability(client, agent)
    .then(() => {
      if (!cancelled) {
        unsubscribe = start()
      }
    })
    .catch((error: unknown) => {
      if (!cancelled) {
        onError(error instanceof Error ? error.message : READ_ERROR)
      }
    })
  return () => {
    cancelled = true
    unsubscribe?.()
  }
}
