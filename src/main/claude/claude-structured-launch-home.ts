import { join } from 'node:path'
import type { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { prepareClaudeReceivingAccount } from './claude-receiving-account'

/** Follow the current account selection and pin its environment for this launch. */
export async function resolveClaudeStructuredLaunchHome(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string
): Promise<string> {
  return (await prepareClaudeReceivingAccount(router, env, recordHome)).home
}

async function claudeTranscriptExists(input: {
  providerSessionId: string
  claudeConfigDir: string
}): Promise<boolean> {
  const path = await resolveSessionFilePath('claude', input.providerSessionId, {
    claudeProjectsDir: join(input.claudeConfigDir, 'projects')
  })
  return path !== null
}

/** A stored leaf implies resume; refuse known history in another account instead of starting fresh. */
export async function claudeLaunchResumesTranscript(input: {
  router: ClaudeProfileRouter | undefined
  leafUuid: string | null
  providerSessionId: string
  claudeConfigDir: string
  recordHome: string
  hasTranscript?: typeof claudeTranscriptExists
}): Promise<boolean> {
  const { router, providerSessionId, claudeConfigDir } = input
  if (!router && input.leafUuid !== null) {
    return true
  }
  const hasTranscript = input.hasTranscript ?? claudeTranscriptExists
  if (await hasTranscript({ providerSessionId, claudeConfigDir })) {
    return true
  }
  if (input.leafUuid === null) {
    return false
  }
  const otherHomes = router
    ? [input.recordHome, ...router.accountHomes(), router.systemDefaultHome()]
    : []
  for (const home of otherHomes.filter((home) => home !== claudeConfigDir)) {
    if (await hasTranscript({ providerSessionId, claudeConfigDir: home })) {
      throw new AgentSessionPreSpawnError(
        new Error('claude transcript is not in the selected account'),
        { reason: 'historyInOtherAccount' }
      )
    }
  }
  // A stored leaf still requires resume when its transcript folder is no longer known.
  return true
}
