import { hostFolderAccountBinding } from '../acp/acp-account-binding'
import type { AcpAgentConnection } from '../acp/acp-agent-connection'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { AcpLaunchGate } from '../acp/acp-launch-gate'

type SignInOwner = Pick<AcpAgentConnection, 'close' | 'onExit' | 'exited'>
const retained = new ProviderAcquisitionStarts<SignInOwner>()
const folder = hostFolderAccountBinding('GEMINI_HOME', 'antigravity-chat', ['antigravity-acp'])

export const ANTIGRAVITY_LAUNCH_GATE = new AcpLaunchGate('Antigravity')

export class AntigravitySignInCloseUnprovenError extends Error {
  constructor() {
    super('Antigravity sign-in could not be stopped. Try signing in or starting the chat again.')
  }
}

export async function closeAntigravitySignInOwner(
  home: string,
  connection: SignInOwner
): Promise<void> {
  if (!(await connection.close().catch(() => false)) && !connection.exited) {
    retained.retainFailed(home, connection)
    ANTIGRAVITY_LAUNCH_GATE.retain(connection)
    throw new AntigravitySignInCloseUnprovenError()
  }
}

// Every credential writer retries the exact retained child before preparing its account.
export const antigravityChatAccount = {
  ...folder,
  prepare: async (env: Readonly<Record<string, string>>): Promise<void> => {
    const home = env.GEMINI_HOME
    if (!home) {
      throw new Error('GEMINI_HOME is not set')
    }
    if (!(await retained.stopFailed(home))) {
      throw new AntigravitySignInCloseUnprovenError()
    }
    await folder.prepare?.(env)
  }
}
