// A bot's own tools: a file in its home folder that Orca hands each of the bot's chats at launch (Claude
// as extra MCP config, Codex as thread config), so nothing is written to the owner's own agent config.
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { writeFileAtomicallyIfUnchangedAsync } from '../filesystem/atomic-file-publication-async'
import {
  BotToolServerSchema,
  botToolDetail,
  type BotOwnTool,
  type BotToolServer
} from '../../shared/bot-tools'
import {
  advanceBotToolsEpoch,
  botToolsEpoch,
  botToolsRevision,
  type BotLaunchedTools
} from './bot-tools-revision'
import { botToolsPath } from './bot-tools-path'
import { botToolEntryExtras, type BotToolEntry } from './bot-tool-entry-extras'
import {
  botToolCredentialWriteTransaction,
  botToolCredentialsTransaction,
  changeBotToolCredentials,
  commitBotToolOAuth,
  newBotToolCredentialId,
  readBotToolCredentialSnapshot,
  type BotToolCredential
} from './bot-tool-credentials'

/** A credential saved with a tools change: saved or sourced headers, or a new Orca sign-in. */
export type BotToolNewCredential = BotToolCredential | { url: string; signIn: true }
import { revokeBotToolSignIns } from './tool-oauth/bot-tool-oauth-revoke'
import { botToolSignInState } from './tool-oauth/bot-tool-oauth-tokens'

const BotToolsFile = z.looseObject({ servers: z.array(z.record(z.string(), z.unknown())) })
const stale = () =>
  new Error('Tools changed since this editor opened. Close and reopen it before saving.')

export { botToolsPath }

export type BotToolsSnapshot = {
  text: string | null
  file: z.infer<typeof BotToolsFile>
  servers: BotToolServer[]
  credentials: Awaited<ReturnType<typeof readBotToolCredentialSnapshot>>
  version: string
}

async function readRawSnapshot(folder: string): Promise<BotToolsSnapshot> {
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
  const credentials = await readBotToolCredentialSnapshot(folder)
  return {
    text,
    file: parsed.data,
    servers,
    credentials,
    // A header-only edit keeps the file and its credential id, so the saved values count too.
    version: createHash('sha256')
      .update(text ?? '')
      .update(credentials.fingerprint(credentialsOf(servers)))
      .digest('hex')
  }
}

const hasInlineHeaders = (server: BotToolServer): boolean =>
  'url' in server && Object.keys(server.headers ?? {}).length > 0

const credentialsOf = (servers: readonly BotToolServer[]): Set<string> =>
  new Set(
    servers.flatMap((server) => ('url' in server && server.credential ? [server.credential] : []))
  )

/** Each server with its extra keys; `file.servers` and `servers` list the same entries in order. */
export const botToolEntries = (snapshot: BotToolsSnapshot): BotToolEntry[] =>
  snapshot.servers.map((server, i) => ({
    server,
    extras: botToolEntryExtras(snapshot.file.servers[i])
  }))

/**
 * Writes `entries`, moving any header values into the host's credential store. An entry's `extras`
 * replaces its server's kept extra keys; without them they carry over from its previous entry.
 */
async function writeServers(
  folder: string,
  snapshot: BotToolsSnapshot,
  entries: readonly BotToolChange[],
  rename?: { from: string; to: string },
  credentials: ReadonlyMap<string, BotToolNewCredential> = new Map()
): Promise<void> {
  const added = new Map<string, BotToolCredential>()
  // New sign-ins start signed out, created with the file write and rolled back with it.
  const signIns = new Map<string, string>()
  for (const [id, credential] of credentials) {
    if ('signIn' in credential) {
      signIns.set(id, credential.url)
    } else {
      added.set(id, credential)
    }
  }
  const stored = entries.map(({ server, extras }): Record<string, unknown> => {
    const previous = snapshot.file.servers.find(
      (entry) => entry.name === (rename?.to === server.name ? rename.from : server.name)
    )
    const unknown = botToolEntryExtras(extras ?? previous)
    if (!('url' in server)) {
      return { ...unknown, ...server }
    }
    const { headers, credential, ...rest } = server
    const signIn = credential ? snapshot.credentials.oauth(credential) : null
    if (signIn && signIn.url !== server.url) {
      // A new address is another app to sign in to: the old sign-in goes, and a new one starts out.
      const id = newBotToolCredentialId()
      signIns.set(id, server.url)
      return { ...unknown, ...rest, credential: id }
    }
    if (headers && Object.keys(headers).length > 0) {
      // The same id across edits keeps a running chat's relay address working with the new values.
      const previousId = typeof previous?.credential === 'string' ? previous.credential : undefined
      const id = credential ?? previousId ?? newBotToolCredentialId()
      added.set(id, { url: server.url, headers })
      return { ...unknown, ...rest, credential: id }
    }
    return { ...unknown, ...rest, ...(credential ? { credential } : {}) }
  })
  const kept = new Set(
    stored.flatMap((server) => (typeof server.credential === 'string' ? [server.credential] : []))
  )
  const removed = new Set([...credentialsOf(snapshot.servers)].filter((id) => !kept.has(id)))
  const replaced = new Map(
    [...added.keys()].flatMap((id) => {
      const saved = snapshot.credentials.credential(id)
      return saved ? [[id, saved] as const] : []
    })
  )
  // The file still names the old values when its write fails: put them back, drop only new ids
  // and the sign-ins this write created.
  const created: string[] = []
  const rollBack = async () => {
    await changeBotToolCredentials(
      folder,
      replaced,
      new Set([...added.keys()].filter((id) => !replaced.has(id)))
    )
    for (const id of created) {
      await commitBotToolOAuth(folder, id, () => null)
    }
  }
  // Publishes every value or throws having written none, so a refusal has nothing to roll back.
  await changeBotToolCredentials(folder, added)
  let written: boolean
  try {
    for (const [id, url] of signIns) {
      const entry = await commitBotToolOAuth(folder, id, (current) =>
        current ? undefined : { url, grant: 0, record: { resource: url } }
      )
      if (!entry) {
        throw new Error('The bot’s tool credentials changed in another Orca. Try again.')
      }
      created.push(id)
    }
    // The async writer drops superseded copies that may still contain inline credentials.
    written = await writeFileAtomicallyIfUnchangedAsync(
      botToolsPath(folder),
      snapshot.text,
      `${JSON.stringify({ ...snapshot.file, servers: stored }, null, 2)}\n`
    )
  } catch (error) {
    await rollBack()
    throw error
  }
  if (!written) {
    await rollBack()
    throw stale()
  }
  revokeBotToolSignIns(await changeBotToolCredentials(folder, new Map(), removed))
}

/** The file as it stands; header values an older Orca left inline move to the credential store first. */
async function readMigratedSnapshot(folder: string): Promise<BotToolsSnapshot> {
  const snapshot = await readRawSnapshot(folder)
  if (!snapshot.servers.some(hasInlineHeaders)) {
    return snapshot
  }
  await mkdir(dirname(botToolsPath(folder)), { recursive: true })
  await writeServers(folder, snapshot, botToolEntries(snapshot))
  return readRawSnapshot(folder)
}

export async function readBotToolsSnapshot(folder: string): Promise<BotToolsSnapshot> {
  const snapshot = await botToolCredentialsTransaction(folder, () => readRawSnapshot(folder))
  return snapshot.servers.some(hasInlineHeaders)
    ? botToolCredentialWriteTransaction(folder, () => readMigratedSnapshot(folder))
    : snapshot
}

export async function readBotToolServers(folder: string): Promise<BotToolServer[]> {
  return (await readBotToolsSnapshot(folder)).servers
}

/**
 * `credentials` are saved with the change, for servers that name them: headers from a source, or a
 * new signed-out sign-in (`{ url, signIn: true }`) for a tool Orca signs in to.
 */
export function changeBotToolServers(
  folder: string,
  change: (
    servers: BotToolServer[],
    credentials: BotToolsSnapshot['credentials']
  ) => BotToolServer[] | Promise<BotToolServer[]>,
  expectedVersion?: string,
  rename?: { from: string; to: string },
  credentials?: ReadonlyMap<string, BotToolNewCredential>
): Promise<void> {
  const changeServers = async (entries: BotToolEntry[], saved: BotToolsSnapshot['credentials']) => {
    const servers = await change(
      entries.map((entry) => entry.server),
      saved
    )
    return servers.map((server) => ({ server }))
  }
  return changeBotToolEntries(folder, changeServers, { expectedVersion, rename, credentials })
}

/** A server to write; with `extras`, they replace the ones its entry kept. */
type BotToolChange = { server: BotToolServer; extras?: Record<string, unknown> }

/** As `changeBotToolServers`; the change can also set each server's extra keys, and `topLevel`
 *  the file's own keys beside `servers`. */
export function changeBotToolEntries(
  folder: string,
  change: (
    entries: BotToolEntry[],
    credentials: BotToolsSnapshot['credentials']
  ) => BotToolChange[] | Promise<BotToolChange[]>,
  {
    expectedVersion,
    rename,
    credentials,
    topLevel
  }: {
    expectedVersion?: string
    rename?: { from: string; to: string }
    credentials?: ReadonlyMap<string, BotToolNewCredential>
    topLevel?: (file: Readonly<Record<string, unknown>>) => Record<string, unknown>
  } = {}
): Promise<void> {
  return botToolCredentialWriteTransaction(folder, async () => {
    const snapshot = await readMigratedSnapshot(folder)
    if (expectedVersion !== undefined && expectedVersion !== snapshot.version) {
      throw stale()
    }
    const entries = await change(botToolEntries(snapshot), snapshot.credentials)
    const file = topLevel ? { ...topLevel(snapshot.file), servers: snapshot.file.servers } : null
    await mkdir(dirname(botToolsPath(folder)), { recursive: true })
    const target = file ? { ...snapshot, file } : snapshot
    await writeServers(folder, target, entries, rename, credentials)
    advanceBotToolsEpoch(folder)
  })
}

/** The revision a launch would read now; concurrent asks for one folder share a read. */
const revisionReads = new Map<string, Promise<string>>()
export function currentBotToolsRevision(folder: string): Promise<string> {
  const running = revisionReads.get(folder)
  if (running) {
    return running
  }
  const epoch = botToolsEpoch(folder)
  const read = readBotToolsSnapshot(folder)
    .then((snapshot) => botToolsRevision(snapshot.version, epoch))
    .finally(() => revisionReads.delete(folder))
  revisionReads.set(folder, read)
  return read
}

export async function writeBotToolServers(
  folder: string,
  servers: readonly BotToolServer[]
): Promise<void> {
  await changeBotToolServers(folder, () => [...servers])
}

/** `folder` is the bot's home, where a tool Orca signs in to has its sign-in. */
export function botOwnTool(server: BotToolServer, folder: string): BotOwnTool {
  const signIn =
    'url' in server && server.credential
      ? botToolSignInState({ folder, credentialId: server.credential })
      : null
  return {
    name: server.name,
    detail: botToolDetail(server),
    // A tool with saved values or Orca's own sign-in goes through Orca's relay; its CLI never signs in.
    remote: 'url' in server && !server.credential,
    ...(signIn ? { signIn } : {})
  }
}

/** A bot's own servers for a launch in its home folder. `launched` comes from the same read, so a
 *  write during launch can't look applied. */
export async function readBotLaunchServers(folder: string): Promise<{
  servers: BotToolServer[]
  launched: BotLaunchedTools
}> {
  // Read before the file: a write in between makes this launch look stale, never current.
  const epoch = botToolsEpoch(folder)
  const snapshot = await readBotToolsSnapshot(folder)
  return {
    servers: snapshot.servers,
    launched: { folder, revision: botToolsRevision(snapshot.version, epoch), epoch }
  }
}
