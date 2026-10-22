import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { AcpStoredUserMessage, AcpStoredUserMessagesReader } from '../acp/acp-recovery-history'
import { resolveOmpSessionsDir } from '../ai-vault/omp-session-root'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'
import {
  openLocalRegularFile,
  readLocalFileBounded
} from '../ipc/filesystem/local-regular-file-read'
import { findOmpSessionByCwd } from './omp-session-cwd-lookup'

const MAX_RECOVERY_BYTES = 16 * 1024 * 1024
const MAX_RECOVERY_RECORDS = 100_000
const TRUNCATION_NOTICE = '\n\n[Session persistence truncated large content]'

type Entry = {
  parentId: string | null
  message: AcpStoredUserMessage | null
}

/** Presence evidence, not model context: compaction never erases a saved ancestor's delivery. */
function storedMessages(
  content: string,
  sessionId: string
): { cwd: string; messages: AcpStoredUserMessage[] } | null {
  if (!content.endsWith('\n')) {
    return null
  }
  const entries = new Map<string, Entry>()
  let headerCwd: string | null = null
  let leaf: string | null = null
  let lineCount = 0
  let start = 0
  while (start < content.length) {
    const end = content.indexOf('\n', start)
    const line = content.slice(start, end)
    start = end + 1
    if (!line.trim()) {
      continue
    }
    if (++lineCount > MAX_RECOVERY_RECORDS) {
      return null
    }
    const record = parseJsonObject(line)
    if (!record) {
      return null
    }
    if (headerCwd === null) {
      if (lineCount === 1 && record.type === 'title') {
        continue
      }
      if (
        record.type !== 'session' ||
        record.id !== sessionId ||
        (record.version !== 2 && record.version !== 3) ||
        typeof record.cwd !== 'string' ||
        !isAbsolute(record.cwd)
      ) {
        return null
      }
      headerCwd = record.cwd
      continue
    }
    const { id, parentId } = record
    if (
      typeof id !== 'string' ||
      !id ||
      entries.has(id) ||
      !(parentId === null || (typeof parentId === 'string' && entries.has(parentId)))
    ) {
      return null
    }
    let message: AcpStoredUserMessage | null = null
    const body = record.type === 'message' ? asRecord(record.message) : null
    if (body?.role === 'user') {
      const blocks: AcpStoredUserMessage['blocks'] = []
      if (typeof body.content === 'string' && !body.content.endsWith(TRUNCATION_NOTICE)) {
        blocks.push({ type: 'text', text: body.content })
      } else if (Array.isArray(body.content)) {
        for (const value of body.content) {
          const block = asRecord(value)
          // Never turn an image/blob/truncated payload into evidence for a text-only send.
          if (
            block?.type !== 'text' ||
            typeof block.text !== 'string' ||
            block.text.endsWith(TRUNCATION_NOTICE)
          ) {
            blocks.length = 0
            break
          }
          blocks.push({ type: 'text', text: block.text })
        }
      }
      const envelopeTime =
        typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
      const createdAt =
        typeof body.timestamp === 'number' ? Math.min(body.timestamp, envelopeTime) : envelopeTime
      if (blocks.length && Number.isFinite(createdAt)) {
        message = { id, blocks, createdAt }
      }
    }
    entries.set(id, { parentId, message })
    // OMP v18.11.2 sessionEntryLeafId: late model_usage restores its captured branch.
    if (record.type === 'model_usage' && record.activeLeafId !== undefined) {
      if (!(record.activeLeafId === null || typeof record.activeLeafId === 'string')) {
        return null
      }
      leaf = record.activeLeafId
    } else {
      leaf = id
    }
  }
  if (headerCwd === null) {
    return null
  }
  if (leaf !== null && !entries.has(leaf)) {
    return null
  }
  const messages: AcpStoredUserMessage[] = []
  while (leaf !== null) {
    const entry = entries.get(leaf)
    if (!entry) {
      return null
    }
    if (entry.message) {
      messages.push(entry.message)
    }
    leaf = entry.parentId
  }
  return { cwd: headerCwd, messages }
}

/** Runs only on the execution host, against the sealed launch environment and known cwd. */
export function ompStoredUserMessagesReader(): AcpStoredUserMessagesReader {
  return async ({ env, cwd, providerSessionId, signal }) => {
    try {
      signal.throwIfAborted()
      const homeDir = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
      const sessionsDir = resolveOmpSessionsDir({ env, homeDir })
      if (!sessionsDir || !isAbsolute(sessionsDir) || !isAbsolute(cwd)) {
        return null
      }
      const file = await findOmpSessionByCwd({
        sessionsDir,
        sessionId: providerSessionId,
        cwd,
        homeDir,
        env,
        requireUnique: true,
        signal
      })
      if (!file) {
        return null
      }
      signal.throwIfAborted()
      const { handle, stats } = await openLocalRegularFile(file)
      try {
        if (stats.size > MAX_RECOVERY_BYTES) {
          return null
        }
        const content = await readLocalFileBounded(handle, MAX_RECOVERY_BYTES, stats.size)
        signal.throwIfAborted()
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
        const parsed = storedMessages(text, providerSessionId)
        if (!parsed) {
          return null
        }
        const headerCwd = parsed.cwd
        const [savedCwd, launchCwd] = await Promise.all([
          realpath(headerCwd).catch(() => resolve(headerCwd)),
          realpath(cwd).catch(() => resolve(cwd))
        ])
        if (savedCwd !== launchCwd) {
          return null
        }
        return parsed.messages
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }
}
