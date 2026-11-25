// A bot's own tools: a file in its home folder that Orca hands each of the bot's chats at launch (Claude
// as extra MCP config, Codex as thread config), so nothing is written to the owner's own agent config.
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { writeFileAtomicallyIfUnchanged } from '../filesystem/atomic-file-publication'
import {
  BotToolServerSchema,
  botToolDetail,
  type BotOwnTool,
  type BotToolServer
} from '../../shared/bot-tools'
import type { Bot } from '../../shared/bot-types'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { BotLaunchTools } from './bot-launch-tools'
import {
  advanceBotToolsEpoch,
  botToolsEpoch,
  botToolsRevision,
  type BotLaunchedTools
} from './bot-tools-revision'
import { botToolRelay, type BotToolRelay } from './tool-relay/bot-tool-relay'
import { botToolsPath } from './bot-tools-path'
import { botToolEntryExtras, type BotToolEntry } from './bot-tool-entry-extras'
import {
  botToolCredentialsTransaction,
  changeBotToolCredentials,
  commitBotToolOAuth,
  newBotToolCredentialId,
  botToolCredentialsFingerprint,
  readBotToolCredential,
  readBotToolOAuth,
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
  return {
    text,
    file: parsed.data,
    servers,
    // A header-only edit keeps the file and its credential id, so the saved values count too.
    version: createHash('sha256')
      .update(text ?? '')
      .update(botToolCredentialsFingerprint(folder, credentialsOf(servers)))
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
function writeServers(
  folder: string,
  snapshot: BotToolsSnapshot,
  entries: readonly BotToolChange[],
  rename?: { from: string; to: string },
  credentials: ReadonlyMap<string, BotToolNewCredential> = new Map()
): void {
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
    const signIn = credential ? readBotToolOAuth(folder, credential) : null
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
      const saved = readBotToolCredential(folder, id)
      return saved ? [[id, saved] as const] : []
    })
  )
  // The file still names the old values when its write fails: put them back, drop only new ids
  // and the sign-ins this write created.
  const created: string[] = []
  const rollBack = () => {
    changeBotToolCredentials(
      folder,
      replaced,
      new Set([...added.keys()].filter((id) => !replaced.has(id)))
    )
    for (const id of created) {
      commitBotToolOAuth(folder, id, () => null)
    }
  }
  // Publishes every value or throws having written none, so a refusal has nothing to roll back.
  changeBotToolCredentials(folder, added)
  let written: boolean
  try {
    for (const [id, url] of signIns) {
      const entry = commitBotToolOAuth(folder, id, (current) =>
        current ? undefined : { url, grant: 0, record: { resource: url } }
      )
      if (!entry) {
        throw new Error('The bot’s tool credentials changed in another Orca. Try again.')
      }
      created.push(id)
    }
    written = writeFileAtomicallyIfUnchanged(
      botToolsPath(folder),
      snapshot.text,
      `${JSON.stringify({ ...snapshot.file, servers: stored }, null, 2)}\n`,
      // Older files hold header values inline: an earlier copy is never kept beside it.
      { mode: 0o600, credential: true }
    )
  } catch (error) {
    rollBack()
    throw error
  }
  if (!written) {
    rollBack()
    throw stale()
  }
  revokeBotToolSignIns(changeBotToolCredentials(folder, new Map(), removed))
}

/** The file as it stands; header values an older Orca left inline move to the credential store first. */
async function readMigratedSnapshot(folder: string): Promise<BotToolsSnapshot> {
  const snapshot = await readRawSnapshot(folder)
  if (!snapshot.servers.some(hasInlineHeaders)) {
    return snapshot
  }
  await mkdir(dirname(botToolsPath(folder)), { recursive: true })
  writeServers(folder, snapshot, botToolEntries(snapshot))
  return readRawSnapshot(folder)
}

export function readBotToolsSnapshot(folder: string): Promise<BotToolsSnapshot> {
  return botToolCredentialsTransaction(folder, () => readMigratedSnapshot(folder))
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
  change: (servers: BotToolServer[]) => BotToolServer[],
  expectedVersion?: string,
  rename?: { from: string; to: string },
  credentials?: ReadonlyMap<string, BotToolNewCredential>
): Promise<void> {
  const changeServers = (entries: BotToolEntry[]) =>
    change(entries.map((entry) => entry.server)).map((server) => ({ server }))
  return changeBotToolEntries(folder, changeServers, { expectedVersion, rename, credentials })
}

/** A server to write; with `extras`, they replace the ones its entry kept. */
type BotToolChange = { server: BotToolServer; extras?: Record<string, unknown> }

/** As `changeBotToolServers`; the change can also set each server's extra keys, and `topLevel`
 *  the file's own keys beside `servers`. */
export function changeBotToolEntries(
  folder: string,
  change: (entries: BotToolEntry[]) => BotToolChange[],
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
  return botToolCredentialsTransaction(folder, async () => {
    const snapshot = await readMigratedSnapshot(folder)
    if (expectedVersion !== undefined && expectedVersion !== snapshot.version) {
      throw stale()
    }
    const entries = change(botToolEntries(snapshot))
    const file = topLevel ? { ...topLevel(snapshot.file), servers: snapshot.file.servers } : null
    await mkdir(dirname(botToolsPath(folder)), { recursive: true })
    writeServers(folder, file ? { ...snapshot, file } : snapshot, entries, rename, credentials)
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

/** Any agent's session in a bot's home folder gets that bot's own tools and token; any other session none.
 *  `launched` comes from the same read as the tools, so a write during launch can't look applied. */
export async function botSessionToolServers(
  bots: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[],
  record: { provider: string; location: { workspaceId: string } },
  launchDirectory: string,
  relay: Pick<BotToolRelay, 'grant'> = botToolRelay
): Promise<{ tools: BotLaunchTools; launched: BotLaunchedTools | null }> {
  const bot = bots.find(
    (entry) => folderWorkspaceKey(entry.folderWorkspaceId) === record.location.workspaceId
  )
  if (!bot) {
    return { tools: BotLaunchTools.none, launched: null }
  }
  // Read before the file: a write in between makes this launch look stale, never current.
  const epoch = botToolsEpoch(launchDirectory)
  const snapshot = await readBotToolsSnapshot(launchDirectory)
  return {
    tools: await BotLaunchTools.for(
      relay,
      { botId: bot.id, folder: launchDirectory, agent: record.provider },
      snapshot.servers
    ),
    launched: {
      folder: launchDirectory,
      revision: botToolsRevision(snapshot.version, epoch),
      epoch
    }
  }
}
