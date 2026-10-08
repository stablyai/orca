import { join } from 'node:path'
import type { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { resolveStructuredClaudeAccountHomePath } from '../runtime/structured-agent-account-home'

/**
 * The folder a structured launch runs under, and the env patch that pins it there.
 * With account routing every launch follows the current selection, as a typed `claude` does.
 */
export async function resolveClaudeStructuredLaunchHome(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string
): Promise<string> {
  if (!router) {
    return recordHome
  }
  const preparation = await router.prepareLaunch()
  // Why read before the patch: System default keeps the launch env's own CLAUDE_CONFIG_DIR.
  const launchHome =
    preparation.provenance === 'system'
      ? resolveStructuredClaudeAccountHomePath({
          launchEnv: env,
          wslDistro: null,
          getClaudeConfigDirectory: () => router.systemDefaultHome()
        })
      : preparation.configDir
  applyClaudeEnvPatch(env, preparation.envPatch)
  return launchHome
}

/** The transcript Claude wrote for this id under the given config folder, if it wrote one. */
export function claudeTranscriptPath(input: {
  providerSessionId: string
  claudeConfigDir: string
}): Promise<string | null> {
  return resolveSessionFilePath('claude', input.providerSessionId, {
    claudeProjectsDir: join(input.claudeConfigDir, 'projects')
  })
}

/** Whether Claude wrote a transcript for this id under the given config folder. */
export async function claudeTranscriptExists(
  input: Parameters<typeof claudeTranscriptPath>[0]
): Promise<boolean> {
  return (await claudeTranscriptPath(input)) !== null
}

/**
 * Whether a chat with a recorded session resumes it. Unrouted, a stored leaf proves a transcript;
 * routed, the selected account may not be the one holding it, and starting fresh would drop the chat.
 */
export async function claudeLaunchResumesTranscript(input: {
  router: ClaudeProfileRouter | undefined
  leafUuid: string | null
  providerSessionId: string
  claudeConfigDir: string
  hasTranscript?: typeof claudeTranscriptExists
}): Promise<boolean> {
  if (input.leafUuid === null) {
    const { providerSessionId, claudeConfigDir } = input
    return (input.hasTranscript ?? claudeTranscriptExists)({ providerSessionId, claudeConfigDir })
  }
  await refuseClaudeTranscriptInOtherAccount(input)
  // Found nowhere Orca knows of (e.g. a folder since removed): the stored leaf still says it ran.
  return true
}

/** Refuses a conversation the selected account does not hold and another account does. Unrouted,
 *  the home is fixed, so nothing is looked up. */
export async function refuseClaudeTranscriptInOtherAccount(input: {
  router: ClaudeProfileRouter | undefined
  providerSessionId: string
  claudeConfigDir: string
  hasTranscript?: typeof claudeTranscriptExists
}): Promise<void> {
  const { router, providerSessionId, claudeConfigDir } = input
  const hasTranscript = input.hasTranscript ?? claudeTranscriptExists
  if (!router || (await hasTranscript({ providerSessionId, claudeConfigDir }))) {
    return
  }
  const otherHomes = [...router.accountHomes(), router.systemDefaultHome()]
  for (const home of otherHomes.filter((home) => home !== claudeConfigDir)) {
    if (await hasTranscript({ providerSessionId, claudeConfigDir: home })) {
      throw new AgentSessionPreSpawnError(
        new Error('claude transcript is not in the selected account'),
        { reason: 'historyInOtherAccount' }
      )
    }
  }
}
