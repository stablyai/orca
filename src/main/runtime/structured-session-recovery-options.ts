import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { agentSessionPinnedLaunchDirectory } from './agent-session-record-launch-directory'
import { structuredAgentRuntimeMetadata } from './structured-agent-runtime-metadata'
import type { StructuredAgentTranscriptImport } from '../native-chat/structured-agent-cli-conversations'

export type RecoveryContextCache = {
  key?: string
  path?: string
  pending?: Promise<string | null>
}

/** One located native file and one flight per source; no transcript content is retained. */
async function readableContext(
  cache: RecoveryContextCache,
  key: string,
  store: string,
  importer: StructuredAgentTranscriptImport,
  locate: () => Promise<string | null>
): Promise<string | null> {
  if (cache.key === key && cache.pending) {
    return cache.pending
  }
  const previous = cache.key === key ? cache.path : undefined
  const admittedFile = async (candidate: string | null | undefined) => {
    const path =
      candidate && (await importer.admitTranscriptPath({ store, transcriptPath: candidate }))
    return path && isAbsolute(path) && (await stat(path).catch(() => null))?.isFile() ? path : null
  }
  const run = async () => {
    return (await admittedFile(previous)) ?? admittedFile(await locate())
  }
  const pending = run().catch((error: unknown) => {
    console.warn('Could not locate saved chat context', error)
    return null
  })
  Object.assign(cache, { key, path: undefined, pending })
  try {
    const path = await pending
    if (cache.pending === pending) {
      cache.path = path ?? undefined
    }
    return path
  } finally {
    if (cache.pending === pending) {
      cache.pending = undefined
    }
  }
}

/** Facts are rederived at action time; only the identified readable content is reusable. */
export async function structuredSessionRecoveryOptions(
  record: AgentSessionRecord | null,
  launchEnv: NodeJS.ProcessEnv,
  input: {
    cache: RecoveryContextCache
    resolveWorkspacePath?: (workspaceId: string) => Promise<string>
  }
): Promise<{ canSwitchAccount: boolean; transcriptPath?: string }> {
  const metadata = record && structuredAgentRuntimeMetadata(record.provider)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  const importer = metadata?.transcriptImport
  if (!record || !metadata || !head || !importer || importer.readableContext.kind !== 'file') {
    return { canSwitchAccount: false }
  }
  try {
    const store = importer.conversationStore({ accountHome: record.accountHome, launchEnv })
    if (!store) {
      return { canSwitchAccount: false }
    }
    const source = {
      provider: record.provider,
      handle: head,
      accountHome: record.accountHome,
      store,
      providerSessionId: metadata.sessionHistory.rowSessionId(head),
      workspaceCwd:
        agentSessionPinnedLaunchDirectory(record) ??
        (await input.resolveWorkspacePath?.(record.location.workspaceId)) ??
        ''
    }
    const key = JSON.stringify([record.providerHandleChain, source])
    const transcriptPath = await readableContext(input.cache, key, store, importer, () =>
      importer.handleNamesTranscript
        ? importer.admitTranscriptPath({ store, transcriptPath: head.handle.nativeId })
        : importer.findTranscript({ ...source, launchEnv })
    )
    if (!transcriptPath) {
      return { canSwitchAccount: false }
    }
    const router = getClaudeProfileRouter()
    let canSwitchAccount = false
    if (
      router &&
      record.provider === 'claude' &&
      record.location.wslDistro === null &&
      metadata.launchFollowsSelection?.()
    ) {
      try {
        const roots = await Promise.all(
          [
            store,
            ...(await router.accountSelectionHomes(launchEnv)).map((home) => join(home, 'projects'))
          ].map((root) => realpath(root))
        )
        canSwitchAccount = roots.every((root) => root === roots[0])
      } catch {
        canSwitchAccount = false
      }
    }
    return { canSwitchAccount, transcriptPath }
  } catch (error) {
    console.warn('Could not read chat recovery options', error)
    return { canSwitchAccount: false }
  }
}
