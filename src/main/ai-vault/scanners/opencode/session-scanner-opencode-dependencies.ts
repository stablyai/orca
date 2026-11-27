import { createHash } from 'node:crypto'
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
    await observe(join(messages, name))
    const messageId = name.slice(0, -5)
    if (!messageId || messageId === '.' || messageId === '..' || /[/\\\0]/.test(messageId)) {
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
