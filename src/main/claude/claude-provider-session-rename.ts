import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { appendFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { loadClaudeAgentSdk } from './claude-stream-json-connection'

export async function renameClaudeTranscript(
  home: string,
  providerSessionId: string,
  name: string
): Promise<void> {
  const { renameSession } = await loadClaudeAgentSdk()
  await renameSession(providerSessionId, name, {
    sessionStore: {
      load: async () => null,
      append: async (_key, entries) => {
        const projects = join(home, 'projects')
        let transcript: string | undefined
        const directories = await wslGatedReaddir(projects, 'exact').catch((error: unknown) => {
          if (isDefinitiveAbsence(error)) {
            return []
          }
          throw error
        })
        for (const directory of directories) {
          const candidate = join(projects, directory.name, `${providerSessionId}.jsonl`)
          const info = await wslGatedStat(candidate, 'exact').catch((error: unknown) => {
            if (isDefinitiveAbsence(error)) {
              return null
            }
            throw error
          })
          if (!info?.isFile() || info.size === 0) {
            continue
          }
          if (transcript) {
            throw new Error('Claude naming found multiple transcripts in the launch home')
          }
          transcript = candidate
        }
        if (!transcript) {
          throw new Error('Claude naming found no transcript in the launch home')
        }
        await appendTranscriptEntries(transcript, [
          ...entries,
          // Native resume's prompt name is a separate projection from the SDK title.
          { type: 'agent-name', agentName: name.trim(), sessionId: providerSessionId }
        ])
      }
    }
  })
}

/** Starts on a fresh line, so a crash-torn last line can't swallow the title. */
export async function appendTranscriptEntries(
  path: string,
  entries: readonly SessionStoreEntry[]
): Promise<void> {
  const handle = await open(path, 'r')
  let separator = ''
  try {
    const { size } = await handle.stat()
    if (size > 0) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      separator = last[0] === 0x0a ? '' : '\n'
    }
  } finally {
    await handle.close()
  }
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n')
  await appendFile(path, `${separator}${lines}\n`, { flag: 'a' })
}
