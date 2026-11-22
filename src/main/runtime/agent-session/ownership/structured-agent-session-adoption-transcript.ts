import { stat } from 'node:fs/promises'
import type { NativeCodexResumePreparation } from '../../../codex/history/resume/codex-ai-vault-session-resume'
import type { StructuredAgentCliSourceLocator } from '../../../native-chat/conversation-adoption/structured-agent-cli-source'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { resolveStructuredAgentSessionAdoption } from '../../../native-chat/conversation-adoption/structured-agent-session-history-adoption'
import type {
  StructuredAgentTranscriptImport,
  StructuredAgentTranscriptImportSettings
} from '../../../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

export type StructuredAgentSessionAdoptionInput = {
  settings: StructuredAgentTranscriptImportSettings
  agent: StructuredAgentId
  /** The agent's registered importer; only an agent with one adopts. */
  transcriptImport: StructuredAgentTranscriptImport
  providerSessionId: string
  selectedAccountHome: AgentSessionAccountHome
  launchEnv: NodeJS.ProcessEnv
  workspaceCwd: string
  conversationName?: string
  resolveTranscriptSource?: () => StructuredAgentCliSourceLocator
  prepareCodexResume?: NativeCodexResumePreparation
}

/** The transcript and account home a resume adopts, found the way create finds them. */
export async function findStructuredAgentSessionAdoptionTranscript(
  input: StructuredAgentSessionAdoptionInput
) {
  const source = input.resolveTranscriptSource?.()
  const transcriptPath = source?.kind === 'matched' ? source.transcriptPath : undefined
  const candidates = await input.transcriptImport.accountHomeCandidates(input)
  // Resolve each account store once so lookup, hook path and re-admission agree despite environment changes.
  const stores = new Map<AgentSessionAccountHome, string | null>()
  const storeOf = (accountHome: AgentSessionAccountHome): string | null => {
    if (!stores.has(accountHome)) {
      stores.set(
        accountHome,
        input.transcriptImport.conversationStore({
          accountHome,
          launchEnv: input.launchEnv
        })
      )
    }
    return stores.get(accountHome) ?? null
  }
  let admitted: { accountHome: AgentSessionAccountHome; path: string } | null = null
  if (transcriptPath) {
    for (const accountHome of candidates) {
      const store = storeOf(accountHome)
      const path = store
        ? await input.transcriptImport.admitTranscriptPath({ store, transcriptPath })
        : null
      if (path) {
        admitted = { accountHome, path }
        break
      }
    }
  }
  if (transcriptPath && !admitted) {
    throw new Error('The conversation account is not available on this host.')
  }
  const adoption = await resolveStructuredAgentSessionAdoption({
    providerSessionId: input.providerSessionId,
    ...(source?.kind === 'absent' ? { exhaustionReason: 'transcriptUnreadable' as const } : {}),
    candidateAccountHomes: admitted ? [admitted.accountHome] : candidates,
    resolveTranscript: async (args) => {
      // A deleted chat's conversation is never adopted again.
      if (
        getStructuredAgentSessionHost()?.deps.store.deletedChats.hasConversation({
          provider: input.agent,
          providerSessionId: input.providerSessionId
        })
      ) {
        return null
      }
      const exact = admitted?.path
      if (exact) {
        try {
          if ((await stat(exact)).isFile()) {
            return exact
          }
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              (error.code === 'ENOENT' || error.code === 'ENOTDIR')
            )
          ) {
            throw error
          }
        }
      }
      const store = storeOf(args.accountHome)
      if (!store) {
        return null
      }
      const found = await input.transcriptImport.findTranscript({
        providerSessionId: args.providerSessionId,
        store,
        launchEnv: args.launchEnv,
        workspaceCwd: args.workspaceCwd,
        strictErrors: true
      })
      if (!found) {
        return null
      }
      const path = await input.transcriptImport.admitTranscriptPath({
        store,
        transcriptPath: found
      })
      if (!path) {
        throw new Error('The conversation path is outside its account storage.')
      }
      return path
    },
    launchEnv: input.launchEnv,
    workspaceCwd: input.workspaceCwd
  })
  return { adoption, candidates }
}
