import { join } from 'node:path'
import {
  resolveAntigravityChatAuthConfig,
  type AntigravityChatAuthConfig
} from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { durableWriteTempPath, writeFileDurableIfCurrent } from '../filesystem/durable-file-write'
import { hostFolderAccountBinding } from '../acp/launch/acp-account-binding'
import { AcpLaunchGate } from '../acp/launch/acp-launch-gate'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'
import {
  antigravityUserHome,
  copyAntigravityUserRules,
  linkAntigravityUserSkills
} from './antigravity-chat-user-skills'
import { resolveAgentPlatformProject } from './antigravity-agent-platform-project'

const folder = hostFolderAccountBinding('GEMINI_HOME', ANTIGRAVITY_CHAT_HOME_FOLDER, [
  ANTIGRAVITY_ACP_HOME
])

export const ANTIGRAVITY_LAUNCH_GATE = new AcpLaunchGate('Antigravity')

/** The message is suitable for display without further translation. */
export class AntigravityChatSentence extends Error {}

/** What agy reads from Orca's chat home: the key or gcloud method and its project; with Google,
 *  nothing, so agy picks its own saved login as it does in its own home. */
async function settingsProjection(
  auth: AntigravityChatAuthConfig,
  env: Readonly<Record<string, string>>
): Promise<Record<string, unknown>> {
  if (auth.method === 'gemini-api-key') {
    return { auth: { type: auth.method } }
  }
  if (auth.method !== 'agent-platform') {
    return {}
  }
  const { project, location } = await resolveAgentPlatformProject(auth, env)
  if (!project) {
    throw new AntigravityChatSentence(
      'Google Agent Platform needs a Google Cloud project. Run `gcloud config set project <id>` or enter one in Settings.'
    )
  }
  return { auth: { type: auth.method }, gcp: { project, location } }
}

/** Orca's chat home, where agy runs with the key or gcloud saved in Orca and where the chats of
 *  Orca's retired server live on. */
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
    await folder.prepare?.(env)
    const userHome = antigravityUserHome(env)
    await linkAntigravityUserSkills(home, userHome)
    await copyAntigravityUserRules(home, userHome)
    const path = join(home, ANTIGRAVITY_ACP_HOME, 'settings.json')
    const projection = await settingsProjection(auth, env)
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
      throw new AntigravityChatSentence(
        'Antigravity account settings could not be prepared. Check that Orca can write its data folder and try again.',
        { cause }
      )
    }
  }
}
