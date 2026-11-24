import { readFile } from 'node:fs/promises'
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
import { resolveAgentPlatformProject } from './antigravity-agent-platform-project'
import { assertAntigravityChatCredential } from './antigravity-chat-credential'

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

async function gcpProjection(
  auth: AntigravityChatAuthConfig,
  env: Readonly<Record<string, string>>
): Promise<{ gcp?: { project: string; location: string } }> {
  if (auth.method === 'oauth-business') {
    return { gcp: { project: auth.gcpProject, location: auth.gcpLocation } }
  }
  if (auth.method !== 'agent-platform') {
    return {}
  }
  const { project, location } = await resolveAgentPlatformProject(auth, env)
  if (!project) {
    throw new AntigravitySignInSentence(
      'Google Agent Platform needs a Google Cloud project. Run `gcloud config set project <id>` or enter one in Settings.'
    )
  }
  return { gcp: { project, location } }
}

// Every credential writer retries the exact retained child before preparing its account.
export const antigravityChatAccount = {
  ...folder,
  prepare: async (
    env: Readonly<Record<string, string>>,
    config?: AntigravityChatAuthConfig,
    assertCurrent?: () => void,
    purpose: 'chat' | 'listing' = 'chat'
  ): Promise<void> => {
    const auth = resolveAntigravityChatAuthConfig(config)
    const home = env.GEMINI_HOME
    if (!home) {
      throw new Error('GEMINI_HOME is not set')
    }
    const listing = purpose === 'listing'
    // A listing never signs in, so it needs neither a credential check nor the link capture.
    if (!listing) {
      await assertAntigravityChatCredential(auth, env, home)
    }
    if (!(await retained.stopFailed(home))) {
      throw new AntigravitySignInCloseUnprovenError()
    }
    if (!listing && !(await antigravityBrowserHelperWorks())) {
      throw new AntigravitySignInSentence(
        "Antigravity's sign-in link can't be captured on this host. Restart Orca and try again."
      )
    }
    await folder.prepare?.(env)
    await linkAntigravityUserSkills(home, antigravityUserHome(env))
    await writeAntigravityChatSettings(home, auth, env, assertCurrent)
  }
}

/** Writes the chat home's `settings.json` for `auth`, which the server and agy read to pick the
 *  sign-in method (and gcloud's project); an unchanged file is left alone. */
export async function writeAntigravityChatSettings(
  home: string,
  auth: AntigravityChatAuthConfig,
  env: Readonly<Record<string, string>>,
  assertCurrent?: () => void
): Promise<void> {
  const path = join(home, ANTIGRAVITY_ACP_HOME, 'settings.json')
  const projection = JSON.stringify({
    auth: { type: auth.method },
    ...(await gcpProjection(auth, env))
  })
  // Unchanged settings cost no durable write, so a listing or a start mostly writes nothing.
  if ((await readFile(path, 'utf8').catch(() => null)) === projection) {
    return
  }
  try {
    await writeFileDurableIfCurrent(
      durableWriteTempPath(path),
      path,
      projection,
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
