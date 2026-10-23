import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { readStreamedSessionDocument } from '../../ai-vault/session-document-stream'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'

/** Private file I/O; the attached persistence drain serializes its operations. */
export function createAgentModelCatalogJson(
  directory: string,
  parseEntry: (value: unknown) => AgentModelCatalogEntry | null,
  persistedEntry: (entry: AgentModelCatalogEntry) => unknown,
  schemaVersion: number
) {
  const path = join(directory, 'agent-model-catalog.json')
  let handle: FileHandle | null = null
  let temporary: string | null = null
  let loading: Promise<AgentModelCatalogEntry[]> | null = null
  const retire = async (): Promise<void> => {
    await handle?.close()
    handle = null
    if (temporary) {
      await unlink(temporary).catch(() => {})
      temporary = null
    }
  }
  const read = (): Promise<AgentModelCatalogEntry[]> => {
    loading ??= (async () => {
      await retire()
      const stream = createReadStream(path, { highWaterMark: 64 * 1024 })
      try {
        const result = await readStreamedSessionDocument({
          bytes: stream,
          arrayKey: 'entries',
          fields: ['version'],
          includeArrayValidity: true,
          create: () => new Map<string, AgentModelCatalogEntry>(),
          consume: (rows, value) => {
            const entry = parseEntry(value)
            if (entry && !rows.has(entry.fingerprint)) {
              rows.set(entry.fingerprint, entry)
            }
          }
        })
        if (!result || result.record.version !== schemaVersion || !result.arrayValid) {
          throw new SyntaxError('Invalid model catalog document')
        }
        return [...result.state.values()]
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return []
        }
        throw error
      } finally {
        stream.destroy()
        await finished(stream).catch(() => {})
      }
    })().finally(() => {
      loading = null
    })
    return loading
  }
  const write = async (rows: AgentModelCatalogEntry[]): Promise<void> => {
    await loading
    await retire()
    await mkdir(directory, { recursive: true })
    const target = `${path}.${randomUUID()}.tmp`
    handle = await open(target, 'wx')
    temporary = target
    try {
      await handle.writeFile(`{"version":${schemaVersion},"entries":[`, 'utf8')
      for (let i = 0; i < rows.length; i++) {
        const payload = JSON.stringify(persistedEntry(rows[i]!))
        await handle.writeFile(`${i ? ',' : ''}${payload}`, 'utf8')
        await yieldToEventLoop()
      }
      await handle.writeFile(']}', 'utf8')
      await handle.close()
      handle = null
      await rename(target, path)
    } finally {
      await retire()
    }
  }
  return { read, write }
}
