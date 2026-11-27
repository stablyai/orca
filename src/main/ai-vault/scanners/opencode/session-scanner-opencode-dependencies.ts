import { createHash } from 'node:crypto'
import { extractString } from '../../../../shared/text/trimmed-string'
import { readOpenCodeJsonRecord } from './session-scanner-opencode-parser'
import { basename, extname, join, relative } from 'node:path'
import {
  wslGatedReaddir,
  wslGatedStat
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { isMissingTranscriptPathError } from '../../discovery/session-path-absence'
import { throwIfAiVaultScanCancelled } from '../../scan-lifecycle/ai-vault-scan-cancellation'

/** Message and part writes do not touch the session JSON. Keep their observed revision separate. */
export async function openCodeDependencySignature(
  storageRoot: string,
  sessionPath: string,
  signal?: AbortSignal
): Promise<string> {
  const digest = createHash('sha256')
  const sessionId = basename(sessionPath, extname(sessionPath))
  const messages = join(storageRoot, 'message', sessionId)

  const namesIn = async (directory: string): Promise<string[]> => {
    try {
      const entries = await wslGatedReaddir(directory, 'scan', signal)
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort()
    } catch (error) {
      throwIfAiVaultScanCancelled(signal)
      if (isMissingTranscriptPathError(error)) {
        return []
      }
      throw error
    }
  }
  const observe = async (path: string): Promise<void> => {
    throwIfAiVaultScanCancelled(signal)
    const observed = await wslGatedStat(path, 'scan', signal)
    digest.update(
      JSON.stringify([
        relative(storageRoot, path),
        observed.size,
        observed.mtimeMs,
        observed.ctimeMs
      ])
    )
  }
  for (const name of await namesIn(messages)) {
    const messagePath = join(messages, name)
    await observe(messagePath)
    const message = await readOpenCodeJsonRecord(messagePath, signal)
    const role = extractString(message?.role)
    if (
      !message ||
      (role !== 'user' && role !== 'assistant') ||
      (message.content !== undefined && message.content !== null)
    ) {
      continue
    }
    const messageId = message.id
    if (
      typeof messageId !== 'string' ||
      !messageId ||
      messageId === '.' ||
      messageId === '..' ||
      /[/\\\0]/.test(messageId)
    ) {
      continue
    }
    const parts = join(storageRoot, 'part', messageId)
    for (const part of await namesIn(parts)) {
      await observe(join(parts, part))
    }
  }
  throwIfAiVaultScanCancelled(signal)
  return digest.digest('hex')
}
