import { join } from 'node:path'
import { acquiredCodexSessionAccount } from '../../shared/agent-session-acquired-account'
import {
  agentSessionAccountHomesEqual,
  requireLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { prepareCodexAccountRestartResume } from './codex-legacy-session-resume'
import { getSystemCodexHomePath } from './codex-home-paths'

/** Move only the current conversation before launching with the selected account's credentials. */
export async function prepareCodexStructuredAccountHome(
  record: AgentSessionRecord,
  selected: AgentSessionAccountHome | null | undefined
) {
  if (selected === null) {
    throw new Error('The selected Codex account is unavailable. No request was sent.')
  }
  const acquired = acquiredCodexSessionAccount(record)
  const source = acquired
    ? { variable: 'CODEX_HOME' as const, path: acquired.recipe.home }
    : record.accountHome
  const home = requireLegacyAgentSessionAccountHome(selected ?? source)
  if (home.variable !== 'CODEX_HOME') {
    throw new Error('The selected Codex account has an invalid account home.')
  }
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (head && !agentSessionAccountHomesEqual(source, home)) {
    const previous = requireLegacyAgentSessionAccountHome(source)
    const transcriptPath = await resolveSessionFilePath('codex', head.handle.nativeId, {
      codexSessionsDirs: [join(previous.path, 'sessions')],
      strictErrors: true
    })
    if (!transcriptPath) {
      throw new Error(
        'Codex conversation history is unavailable. The account switch was stopped before sending a request.'
      )
    }
    await prepareCodexAccountRestartResume({
      sourceHome: previous.path,
      transcriptPath,
      targetHome: home.path,
      systemCodexHomePath: getSystemCodexHomePath()
    })
  }
  return home
}
