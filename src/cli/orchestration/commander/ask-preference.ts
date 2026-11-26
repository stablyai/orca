import { z } from 'zod'
import {
  commanderMemoryId,
  commanderPreferenceResult
} from '../../../shared/commander/memory-contract'
import { recurringQuestionLimit } from '../../../shared/commander/recurring-answer'
import { escapeTerminalControlCharacters } from '../../../shared/terminal/output/terminal-control-character-escape'
import { ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV } from '../../../shared/orchestration/orchestration-compatibility-evidence'
import { getRequiredStringFlag } from '../../arguments/flags'
import type { CommandHandler } from '../../dispatch/dispatch'
import { RuntimeClientError } from '../../runtime/connection/types'
import { openDispatchMemory } from './dispatch-memory'

export const askCommanderPreference: CommandHandler = async (ctx) => {
  const { flags, json } = ctx
  const projectId = getRequiredStringFlag(flags, 'commander-project')
  const question = z
    .string()
    .trim()
    .min(1)
    .max(recurringQuestionLimit)
    .safeParse(getRequiredStringFlag(flags, 'question'))
  const requestId = commanderMemoryId.safeParse(getRequiredStringFlag(flags, 'request'))
  if (!question.success || !requestId.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Provide a question of 1–500 characters and a valid Memory request ID.'
    )
  }
  const explicitGrant = [
    process.env.ORCA_COMMANDER_MEMORY_GRANT_FILE,
    process.env.ORCA_COMMANDER_MEMORY_TOKEN,
    process.env.ORCA_COMMANDER_MEMORY_URL
  ].some((value) => value !== undefined)
  let result: z.infer<typeof commanderPreferenceResult>
  if (explicitGrant) {
    const memory = await openDispatchMemory(projectId)
    result = await memory.askPreference(question.data, requestId.data)
  } else {
    const capability = process.env.ORCA_COMMANDER_HOME_CAPABILITY
    if (!capability || !/^[A-Za-z0-9_-]{43}$/u.test(capability)) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Ask from the Commander Home chat or configure a project Commander Memory grant.'
      )
    }
    const { client } = ctx
    if (client.isRemote || process.env[ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV]) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Commander Home can ask only on its local desktop runtime.'
      )
    }
    // Local RuntimeClient.call uses the existing Unix socket or named pipe. Never forward the launch capability.
    const response = await client.call<unknown>('commanderChat.askPreference', {
      capability,
      projectId,
      requestId: requestId.data,
      question: question.data
    })
    result = commanderPreferenceResult.parse(response.result)
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, result }))
  } else {
    console.log(
      result.matched
        ? `${escapeTerminalControlCharacters(result.answer)}\nRule ${result.rulePageId} v${result.ruleVersion} · Decision ${result.decisionPageId}`
        : result.reason === 'disabled'
          ? 'Automatic answers are off. Ask the owner.'
          : `No single saved answer (${result.reason}). Ask the owner.`
    )
  }
}
