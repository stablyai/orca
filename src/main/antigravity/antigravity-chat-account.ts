import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { durableWriteTempPath, writeFileDurableIfCurrent } from '../filesystem/durable-file-write'
import type {
  AntigravityChatAuth,
  AntigravityChatSignInState
} from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import { RevisionedState } from '../runtime/events/revisioned-state'
import { AcpLaunchGate } from '../acp/launch/acp-launch-gate'
import { AGY_HOST_SELECTION } from './agy-account-selection'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { resolveAgentPlatformProject } from './antigravity-agent-platform-project'

export const ANTIGRAVITY_LAUNCH_GATE = new AcpLaunchGate('Antigravity', AGY_HOST_SELECTION.started)

/** The message is suitable for display without further translation. */
export class AntigravitySignInSentence extends Error {}

type AntigravityOwnedSignIn = Omit<AntigravityChatSignInState, 'flowId'> & {
  flowId: string
  owner: string
}

/** agy's sign-in as Orca last saw it, and the one in-app sign-in running on this host; its
 *  revision tells every surface to read again. */
export const antigravityChatSignIn = new RevisionedState<{
  auth: AntigravityChatAuth
  flow: AntigravityOwnedSignIn | null
}>({ auth: 'unknown', flow: null })

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

/** Writes the chat home's `settings.json` for `auth`, which agy reads to pick the
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
