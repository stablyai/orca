// The bot tools file as read: its servers, the credential store read with it, and the version an
// editor's stale check and a launch's revision compare, counted from that store when first asked for.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { BotToolServerSchema, type BotToolServer } from '../../shared/bot-tools'
import {
  readBotToolCredentialSnapshot,
  type BotToolCredentialSnapshot
} from './bot-tool-credentials'
import { botToolEntryExtras, type BotToolEntry } from './bot-tool-entry-extras'
import { botToolsPath } from './bot-tools-path'

const BotToolsFile = z.looseObject({ servers: z.array(z.record(z.string(), z.unknown())) })

export type BotToolsSnapshot = {
  text: string | null
  file: z.infer<typeof BotToolsFile>
  servers: BotToolServer[]
  version: string
  /** Each credential the servers name, by id, as `version` counts it (`botToolCredentialFingerprints`). */
  credentials: ReadonlyMap<string, unknown>
  /** The credential store as read with the file; a write in the same transaction reads values from it. */
  saved: BotToolCredentialSnapshot
}

export async function readRawBotToolsSnapshot(folder: string): Promise<BotToolsSnapshot> {
  let text: string | null
  try {
    text = await readFile(botToolsPath(folder), 'utf8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
    text = null
  }
  const parsed = BotToolsFile.safeParse(
    text === null
      ? { servers: [] }
      : (() => {
          try {
            return JSON.parse(text)
          } catch {
            return null
          }
        })()
  )
  if (
    !parsed.success ||
    parsed.data.servers.some((server) => !BotToolServerSchema.safeParse(server).success) ||
    new Set(parsed.data.servers.map((server) => server.name)).size !== parsed.data.servers.length
  ) {
    throw new Error('The bot tools file is invalid. Repair it before editing tools.')
  }
  const servers = parsed.data.servers.map((server) => BotToolServerSchema.parse(server))
  // Read off the event loop; its entries are opened only when asked: a switch or a list never needs them.
  const saved = await readBotToolCredentialSnapshot(folder)
  let credentials: Map<string, unknown> | undefined
  const fingerprints = () => (credentials ??= saved.fingerprints(credentialsOf(servers)))
  let version: string | undefined
  return {
    text,
    file: parsed.data,
    servers,
    saved,
    // A header-only edit keeps the file and its credential id, so the saved values count too.
    get version() {
      return (version ??= createHash('sha256')
        .update(text ?? '')
        .update(JSON.stringify([...fingerprints()]))
        .digest('hex'))
    },
    get credentials() {
      return fingerprints()
    }
  }
}

export const hasInlineHeaders = (server: BotToolServer): boolean =>
  'url' in server && Object.keys(server.headers ?? {}).length > 0

export const credentialsOf = (servers: readonly BotToolServer[]): Set<string> =>
  new Set(
    servers.flatMap((server) => ('url' in server && server.credential ? [server.credential] : []))
  )

/** Each server with its extra keys; `file.servers` and `servers` list the same entries in order. */
export const botToolEntries = (snapshot: BotToolsSnapshot): BotToolEntry[] =>
  snapshot.servers.map((server, i) => ({
    server,
    extras: botToolEntryExtras(snapshot.file.servers[i])
  }))
