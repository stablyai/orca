import { captureHermesSqliteSessionViaWorker } from './scanners/hermes/session-scanner-hermes-worker'
import {
  buildOpenCodeSqliteCandidatePath,
  splitOpenCodeSqliteCandidate
} from '../../shared/agent-session/lifecycle/provider-handles/opencode-sqlite-session-path'
import {
  AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS,
  isAiVaultDatabaseAgent,
  type AiVaultSessionHandoffArgs,
  type AiVaultSessionHandoffResult
} from '../../shared/ai-vault/contracts/ai-vault-session-handoff'
import { formatWorkerTranscriptMessage } from '../../shared/native-chat/transcript/worker-transcript-text'
import { isWslUncPath, toLinuxPath } from '../../shared/file-access/wsl-paths'
import { readOpenCodeNativeChatTranscriptFull } from '../native-chat/transcript-history/opencode/transcript-opencode'
import { writeAgentSessionContextSnapshot } from '../native-chat/conversation-context/agent-session-context-snapshots'
import { wakeNativeChatTranscriptDistro } from '../native-chat/transcript-discovery/native-chat-open-wake'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { wslDistroForPath } from '../wsl/filesystem/wsl-unc-access-gate'
import { getAiVaultWslScanHomeDirs } from './discovery/ai-vault-scan-roots'
import { openCodeWslPath } from './scanners/opencode/reader-transport/session-scanner-opencode-wsl-client'
import { configureOpenCodeTranscriptWslReaders } from '../native-chat/transcript-history/opencode/transcript-opencode-database'

type DatabaseRow = { dbPath: string; sessionId: string }

async function readOpenCodeHandoffText(
  row: DatabaseRow,
  agent: 'opencode' | 'opencode2' | 'zcode',
  signal: AbortSignal
): Promise<string> {
  const read = await readOpenCodeNativeChatTranscriptFull(
    row.sessionId,
    { resolveDbPath: async () => row.dbPath },
    signal,
    agent === 'zcode' ? 'zcode' : undefined
  )
  return 'error' in read ? '' : read.messages.map(formatWorkerTranscriptMessage).join('\n\n')
}

async function readHermesHandoffText(row: DatabaseRow, signal: AbortSignal): Promise<string> {
  const { messages } = await captureHermesSqliteSessionViaWorker({
    ...row,
    platform: process.platform,
    signal
  })
  return messages.map((message) => `[${message.role}] ${message.text}`).join('\n\n')
}

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
    const text =
      args.agent === 'hermes'
        ? await readHermesHandoffText(row, signal)
        : await readOpenCodeHandoffText(row, args.agent, signal)
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
