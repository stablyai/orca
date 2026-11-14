import { createInterface } from 'node:readline'
import {
  openTranscriptReadStream,
  wslGatedStat
} from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { sessionFileIdentity, sessionFileVersionMatches } from '../parse-cache/session-file-version'
import {
  lookupSessionScopeCwds,
  resolveSessionScopeCwd,
  storeSessionScopeCwd
} from '../parse-cache/session-parse-cache-store'
import type { FileWithMtime } from '../session-scanner-types'
import type { AiVaultAgent } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'
import { extractString } from '../../../shared/trimmed-string'
import { parseJsonObject } from '../parsing/session-json-object'
import { recordRefusal, type IssueSink } from './session-scanner-scope-discovery'

const REPRESENTATIVE_CWD_LINE_LIMIT = 200

export async function readFirstCwd(
  filePath: string,
  issues: IssueSink,
  agent: AiVaultAgent,
  signal?: AbortSignal
): Promise<string | null> {
  const observed = await wslGatedStat(filePath, 'scan', signal)
  const file: FileWithMtime = {
    path: filePath,
    mtimeMs: observed.mtimeMs,
    sizeBytes: observed.size,
    modifiedAt: observed.mtime.toISOString(),
    ...sessionFileIdentity(observed)
  }
  lookupSessionScopeCwds([filePath])
  const known = resolveSessionScopeCwd(
    filePath,
    (stamp) => stamp.platform === process.platform && sessionFileVersionMatches(stamp, file)
  )
  if (typeof known !== 'string') {
    return known.cwd
  }
  const input = openTranscriptReadStream(filePath, { encoding: 'utf-8' }, 'scan', signal)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let read = 0
  try {
    throwIfAiVaultScanCancelled(signal)
    for await (const line of lines) {
      throwIfAiVaultScanCancelled(signal)
      if (read++ >= REPRESENTATIVE_CWD_LINE_LIMIT) {
        break
      }
      const cwd = extractString(parseJsonObject(line)?.cwd)
      if (cwd) {
        storeSessionScopeCwd(filePath, {
          ...sessionFileIdentity(file),
          mtimeMs: file.mtimeMs,
          sizeBytes: file.sizeBytes ?? null,
          platform: process.platform,
          cwd
        })
        return cwd
      }
    }
  } catch (err) {
    throwIfAiVaultScanCancelled(signal)
    recordRefusal(issues, filePath, err, agent)
    return null
  } finally {
    // readline.close() leaves its input open; destroy the stream after early exits and read failures.
    lines.close()
    input.destroy()
  }
  storeSessionScopeCwd(filePath, {
    ...sessionFileIdentity(file),
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform: process.platform,
    cwd: null
  })
  return null
}
