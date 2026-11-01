import type {
  AntigravityChatAuth,
  AntigravityChatSignInState,
  AntigravityChatSignInStatus
} from '../../shared/antigravity-account-types'
import { hostFolderAccountBinding } from '../acp/acp-account-binding'
import type { AcpAgentConnection } from '../acp/acp-agent-connection'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { RevisionedState } from '../runtime/revisioned-state'
import { antigravityBrowserHelperWorks } from './antigravity-browser-helper'
import { AcpLaunchGate } from '../acp/acp-launch-gate'

type SignInOwner = Pick<AcpAgentConnection, 'close' | 'closeOutcome' | 'onExit' | 'exited'>
const retained = new ProviderAcquisitionStarts<SignInOwner>(
  async (connection) => (await connection.closeOutcome()).accepted
)
const folder = hostFolderAccountBinding('GEMINI_HOME', 'antigravity-chat', ['antigravity-acp'])

export const ANTIGRAVITY_LAUNCH_GATE = new AcpLaunchGate('Antigravity')

/** The message is suitable for display without further translation. */
export class AntigravitySignInSentence extends Error {}

export class AntigravitySignInCloseUnprovenError extends AntigravitySignInSentence {
  constructor() {
    super('Antigravity sign-in could not be stopped. Try signing in or starting the chat again.')
  }
}

type AntigravityOwnedSignIn = Omit<AntigravityChatSignInState, 'flowId'> & {
  flowId: string
  owner: string
}

export const antigravityChatSignIn = new RevisionedState<{
  auth: AntigravityChatAuth
  flow: AntigravityOwnedSignIn | null
}>({ auth: 'unknown', flow: null })

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
  let outcome
  try {
    outcome = await connection.closeOutcome()
  } catch (error) {
    retained.retainFailed(home, connection)
    ANTIGRAVITY_LAUNCH_GATE.retain(connection)
    throw error
  }
  if (!outcome.accepted) {
    retained.retainFailed(home, connection)
    ANTIGRAVITY_LAUNCH_GATE.retain(connection)
    throw new AntigravitySignInCloseUnprovenError()
  }
  if (outcome.receive.state === 'failed') {
    throw outcome.receive.error
  }
  if (outcome.cleanupError !== undefined) {
    throw outcome.cleanupError
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

/** A teardown diagnostic must not replace the initiating sign-in error and its mapping. */
export async function withAntigravitySignInOwner(
  home: string,
  connection: SignInOwner,
  work: () => Promise<void>
): Promise<void> {
  let initiating: { error: unknown } | undefined
  try {
    await work()
  } catch (error) {
    initiating = { error }
  }
  try {
    await closeAntigravitySignInOwner(home, connection)
  } catch (cleanupError) {
    if (cleanupError instanceof AntigravitySignInCloseUnprovenError || !initiating) {
      throw cleanupError
    }
    if (cleanupError !== initiating.error) {
      console.warn('[antigravity] sign-in cleanup failed:', cleanupError)
    }
  }
  if (initiating) {
    throw initiating.error
  }
}

/** Hide the flow ID and sign-in link from other clients. */
export function readAntigravityChatSignInStatus(owner: string): AntigravityChatSignInStatus {
  const { value, revision } = antigravityChatSignIn.get()
  if (!value.flow) {
    return { revision, auth: value.auth, flow: null }
  }
  const { owner: starter, ...state } = value.flow
  const { phase, error } = state
  const flow = starter === owner ? state : { flowId: null, phase, ...(error ? { error } : {}) }
  return { revision, auth: value.auth, flow }
}
