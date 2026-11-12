import {
  buildOpenCodeSqliteCandidatePath,
  splitOpenCodeSqliteCandidate
} from '../../shared/opencode-sqlite-session-path'
import {
  AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS,
  isAiVaultDatabaseAgent,
  type AiVaultSessionHandoffArgs,
  type AiVaultSessionHandoffResult
} from '../../shared/ai-vault/contracts/ai-vault-session-handoff'
import { formatWorkerTranscriptMessage } from '../../shared/worker-transcript-text'
import { isWslUncPath, toLinuxPath } from '../../shared/wsl-paths'
import { readOpenCodeNativeChatTranscriptFull } from '../native-chat/transcript-opencode'
import { writeAgentSessionContextSnapshot } from '../native-chat/agent-session-context-snapshots'
import { wakeNativeChatTranscriptDistro } from '../native-chat/native-chat-open-wake'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { wslDistroForPath } from '../wsl/filesystem/wsl-unc-access-gate'
import { getAiVaultWslScanHomeDirs } from './discovery/ai-vault-scan-roots'
import { openCodeWslPath } from './scanners/opencode/reader-transport/session-scanner-opencode-wsl-client'
import { configureOpenCodeTranscriptWslReaders } from '../native-chat/transcript-opencode-database'

/** Copies one database-backed conversation into its own hand-off snapshot on this host,
 *  so the new agent never gets a path to the account-wide database. */
export async function writeAiVaultSessionHandoffSnapshot(
  args: Pick<AiVaultSessionHandoffArgs, 'agent' | 'filePath' | 'sessionId'>
): Promise<AiVaultSessionHandoffResult> {
  if (!isAiVaultDatabaseAgent(args.agent)) {
    return {}
  }
  // Rows carry `<db>#<session id>` or the bare database plus sessionId; both must name a database file.
  const candidate =
    splitOpenCodeSqliteCandidate(args.filePath, args.agent) || !args.sessionId
      ? args.filePath
      : buildOpenCodeSqliteCandidatePath(args.filePath, args.sessionId)
  const row = splitOpenCodeSqliteCandidate(candidate, args.agent)
  if (!row) {
    return {}
  }
  try {
    // Hand-off is a user act: start a stopped distro before the gated database read.
    await wakeNativeChatTranscriptDistro(wslDistroForPath(row.dbPath))
    // No one waits past the caller's budget, so stop reading then too.
    const signal = AbortSignal.timeout(AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS)
    if (openCodeWslPath(row.dbPath)) {
      // This process reads WSL databases through per-distro readers; keep every known distro's.
      const homes = (await getAiVaultWslScanHomeDirs()).slice(0, 32)
      await configureOpenCodeTranscriptWslReaders([...homes, row.dbPath], signal)
    }
    const read = await readOpenCodeNativeChatTranscriptFull(
      row.sessionId,
      { resolveDbPath: async () => row.dbPath },
      signal,
      args.agent === 'zcode' ? 'zcode' : undefined
    )
    if ('error' in read) {
      return {}
    }
    const text = read.messages.map(formatWorkerTranscriptMessage).join('\n\n')
    if (!text.trim()) {
      return {}
    }
    const path = await writeAgentSessionContextSnapshot(
      getProfileUserDataPath(),
      `ai-vault:${candidate}`,
      text
    )
    // A WSL row hands off to a WSL workspace, which reads the Windows temp file through /mnt.
    return { transcriptPath: isWslUncPath(row.dbPath) ? toLinuxPath(path) : path }
  } catch (error) {
    console.warn('[ai-vault] could not save the session for hand-off', error)
    return {}
  }
}
