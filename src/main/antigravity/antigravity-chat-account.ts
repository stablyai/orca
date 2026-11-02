import type {
  AntigravityChatAuth,
  AntigravityChatSignInState
} from '../../shared/antigravity-account-types'
import { hostFolderAccountBinding } from '../acp/acp-account-binding'
import type { AcpAgentConnection } from '../acp/acp-agent-connection'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { RevisionedState } from '../runtime/revisioned-state'
import { antigravityBrowserHelperWorks } from './antigravity-browser-helper'
import { AcpLaunchGate } from '../acp/acp-launch-gate'

type SignInOwner = Pick<AcpAgentConnection, 'close' | 'onExit' | 'exited'>
const retained = new ProviderAcquisitionStarts<SignInOwner>()
const folder = hostFolderAccountBinding('GEMINI_HOME', 'antigravity-chat', ['antigravity-acp'])

export const ANTIGRAVITY_LAUNCH_GATE = new AcpLaunchGate('Antigravity')

/** A failure whose message is already the sentence a person reads. */
export class AntigravitySignInSentence extends Error {}

export class AntigravitySignInCloseUnprovenError extends AntigravitySignInSentence {
  constructor() {
    super('Antigravity sign-in could not be stopped. Try signing in or starting the chat again.')
  }
}

/** A flow as the host holds it: `owner` is the caller that started it. */
type AntigravityOwnedSignIn = Omit<AntigravityChatSignInState, 'flowId'> & {
  flowId: string
  owner: string
}

/** What every client follows by revision; in memory only, as the server's answers are. */
export const antigravityChatSignIn = new RevisionedState<{
  auth: AntigravityChatAuth
  flow: AntigravityOwnedSignIn | null
}>({ auth: 'unknown', flow: null })

/** The server's answer for this host's chats: a session started, or it asked to sign in. */
export function answerAntigravityChatAuth(signedIn: boolean): void {
  const shown = antigravityChatSignIn.get().value
  const auth = signedIn ? 'signedIn' : 'signedOut'
  if (shown.auth !== auth) {
    antigravityChatSignIn.set({ ...shown, auth })
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
    if (!(await antigravityBrowserHelperWorks())) {
      throw new AntigravitySignInSentence(
        "Antigravity's sign-in link can't be captured on this host. Restart Orca and try again."
      )
    }
    await folder.prepare?.(env)
  }
}
