import { join } from 'node:path'
import {
  resolveAntigravityChatAuthConfig,
  type AntigravityChatAuthConfig
} from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { durableWriteTempPath, writeFileDurableIfCurrent } from '../filesystem/durable-file-write'
import type {
  AntigravityChatAuth,
  AntigravityChatSignInState
} from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import { hostFolderAccountBinding } from '../acp/launch/acp-account-binding'
import type { AcpAgentConnection } from '../acp/process/acp-agent-connection'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { RevisionedState } from '../runtime/events/revisioned-state'
import { antigravityBrowserHelperWorks } from './antigravity-browser-helper'
import { AcpLaunchGate } from '../acp/launch/acp-launch-gate'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'
import { antigravityUserHome, linkAntigravityUserSkills } from './antigravity-chat-user-skills'

type SignInOwner = Pick<AcpAgentConnection, 'close' | 'exited'> & {
  onExit(listener: () => void): void
}
const retained = new ProviderAcquisitionStarts<Pick<SignInOwner, 'close' | 'onExit'>>()
const folder = hostFolderAccountBinding('GEMINI_HOME', ANTIGRAVITY_CHAT_HOME_FOLDER, [
  ANTIGRAVITY_ACP_HOME
])

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
  await connection.close().catch(() => false)
  if (!connection.exited) {
    // A delivered kill is not an observed exit; retries must keep the same owner.
    const owner = {
      close: async () => {
        await connection.close().catch(() => false)
        return connection.exited
      },
      onExit: (listener: () => void) => connection.onExit(listener)
    }
    retained.retainFailed(home, owner)
    ANTIGRAVITY_LAUNCH_GATE.retain(owner)
    throw new AntigravitySignInCloseUnprovenError()
  }
}

// Every credential writer retries the exact retained child before preparing its account.
export const antigravityChatAccount = {
  ...folder,
  prepare: async (
    env: Readonly<Record<string, string>>,
    config?: AntigravityChatAuthConfig,
    assertCurrent?: () => void
  ): Promise<void> => {
    const auth = resolveAntigravityChatAuthConfig(config)
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
    await linkAntigravityUserSkills(home, antigravityUserHome(env))
    const path = join(home, ANTIGRAVITY_ACP_HOME, 'settings.json')
    const projection = {
      auth: { type: auth.method },
      ...(auth.method === 'oauth-business'
        ? { gcp: { project: auth.gcpProject, location: auth.gcpLocation } }
        : {})
    }
    try {
      await writeFileDurableIfCurrent(
        durableWriteTempPath(path),
        path,
        JSON.stringify(projection),
        () => {
          assertCurrent?.()
          return true
        },
        0o600
      )
    } catch (cause) {
      assertCurrent?.()
      throw new AntigravitySignInSentence(
        'Antigravity account settings could not be prepared. Check that Orca can write its data folder and try again.',
        { cause }
      )
    }
  }
}
