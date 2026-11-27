// What this Orca last wrote into each agent's MCP file, and the file as it was before: enough to take
// exactly its own entries back out. Like the trust ledger, an unreadable one records nothing, so it
// can only ever leave an entry behind, never take a user's.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { isDeepStrictEqual } from 'node:util'
import { MCP_FILE_AGENTS } from '../../../shared/mcp-servers/mcp-servers'
import { renameFileWithWindowsRetryAsync } from '../../../shared/file-write/windows-retry-file-operations'

const FileRecordSchema = lazyZodSchema(() =>
  z.object({
    agent: z.enum(MCP_FILE_AGENTS),
    /** No file was there before Orca's first entry. */
    created: z.boolean(),
    /** The JSON file had no servers' table before Orca added one. */
    addedTable: z.boolean(),
    /** The file without Orca's entries (null: no file), as of Orca's last write. */
    before: z.string().nullable(),
    /** The whole file as Orca last wrote it; while it still reads so, `before` is exact. */
    written: z.string(),
    /** Each entry's value as written, by name (JSON files, which have no markers). */
    entries: z.record(z.string(), z.unknown())
  })
)
export type McpAgentFileRecord = z.infer<typeof FileRecordSchema>

const LedgerSchema = lazyZodSchema(() =>
  z.object({
    version: z.literal(1),
    files: z.record(z.string(), FileRecordSchema)
  })
)
type Ledger = z.infer<typeof LedgerSchema>

export class McpAgentFileLedger {
  constructor(private readonly path: string) {}

  async read(): Promise<Ledger> {
    try {
      const parsed = LedgerSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      return parsed.success ? parsed.data : { version: 1, files: {} }
    } catch {
      return { version: 1, files: {} }
    }
  }

  async set(configPath: string, record: McpAgentFileRecord | null): Promise<void> {
    const ledger = await this.read()
    if (record && isDeepStrictEqual(ledger.files[configPath], record)) {
      return
    }
    if (record) {
      ledger.files[configPath] = record
    } else if (configPath in ledger.files) {
      delete ledger.files[configPath]
    } else {
      return
    }
    // Owner-only and replaced whole: it holds copies of the agents' files, which can carry tokens.
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await renameFileWithWindowsRetryAsync(temp, this.path)
    } finally {
      await rm(temp, { force: true })
    }
  }
}
