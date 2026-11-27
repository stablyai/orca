// A bot's own tools: a file in its home folder that Orca hands each of the bot's chats at launch (Claude
// as extra MCP config, Codex as thread config), so nothing is written to the owner's own agent config.
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomicallyIfUnchanged } from '../filesystem/atomic-file-publication'
import { botToolDetail, type BotOwnTool, type BotToolServer } from '../../shared/bot-tools'
import {
  advanceBotToolsEpoch,
  botToolsEpoch,
  botToolsRevision,
  type BotLaunchedTools
} from './bot-tools-revision'
import { botToolsPath } from './bot-tools-path'
import { botToolEntryExtras, type BotToolEntry } from './bot-tool-entry-extras'
import {
  botToolEntries,
  credentialsOf,
  hasInlineHeaders,
  readRawBotToolsSnapshot as readRawSnapshot,
  type BotToolsSnapshot
} from './bot-tools-snapshot'
import {
  botToolCredentialsTransaction,
  changeBotToolCredentials,
  commitBotToolOAuth,
  newBotToolCredentialId,
  botToolCredentialsReader,
  type BotToolCredential,
  type BotToolOAuthEntry
} from './bot-tool-credentials'

/** A credential saved with a tools change: saved or sourced headers, or a new Orca sign-in. */
export type BotToolNewCredential = BotToolCredential | { url: string; signIn: true }
import { revokeBotToolSignIns } from './tool-oauth/bot-tool-oauth-revoke'
import { botToolSignInStatusOf } from './tool-oauth/bot-tool-oauth-tokens'

const stale = () =>
  new Error('Tools changed since this editor opened. Close and reopen it before saving.')

export { botToolsPath }
export { botToolEntries, type BotToolsSnapshot } from './bot-tools-snapshot'

/**
 * Writes `entries`, moving any header values into the host's credential store. An entry's `extras`
 * replaces its server's kept extra keys; without them they carry over from its previous entry.
 */
function writeServers(
  folder: string,
  snapshot: BotToolsSnapshot,
  entries: readonly BotToolChange[],
  {
    rename,
    credentials = new Map(),
    file = snapshot.file
  }: Pick<ChangeOptions, 'rename' | 'credentials'> & { file?: BotToolsSnapshot['file'] } = {}
): boolean {
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
  // Names are unique in a read file, so each entry finds its previous one without a search.
  const previousByName = new Map(file.servers.map((entry) => [entry.name, entry]))
  // Nothing changes the store before this write's own changes below, so one read answers every row.
  const saved = botToolCredentialsReader(folder)
  const stored = entries.map(({ server, extras }): Record<string, unknown> => {
    const previous = previousByName.get(rename?.to === server.name ? rename.from : server.name)
    const unknown = botToolEntryExtras(extras ?? previous)
    if (!('url' in server)) {
      return { ...unknown, ...server }
    }
    const { headers, credential, ...rest } = server
    // A row other than the one edited, with the address and credential it had and no values to
    // save, can't newly hold a sign-in for another app; every other row's is checked.
    const checked =
      rename?.to === server.name ||
      previous?.url !== server.url ||
      previous?.credential !== credential ||
      Object.keys(headers ?? {}).length > 0
    const signIn = credential && checked ? saved.oauth(credential) : null
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
  const text = `${JSON.stringify({ ...file, servers: stored }, null, 2)}\n`
  // A change that changes nothing (a switch already where it's set) writes nothing.
  if (text === snapshot.text && added.size === 0 && signIns.size === 0 && removed.size === 0) {
    return false
  }
  const replaced = new Map(
    [...added.keys()].flatMap((id) => {
      const values = saved.credential(id)
      return values ? [[id, values] as const] : []
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
      text,
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
  return true
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
  // Each server's extras carry over from its previous entry inside the write.
  const changeServers = (snapshot: BotToolsSnapshot) =>
    change([...snapshot.servers]).map((server) => ({ server }))
  return changeSnapshot(folder, changeServers, { expectedVersion, rename, credentials })
}

/** A server to write; with `extras`, they replace the ones its entry kept. */
type BotToolChange = { server: BotToolServer; extras?: Record<string, unknown> }

type ChangeOptions = {
  expectedVersion?: string
  rename?: { from: string; to: string }
  credentials?: ReadonlyMap<string, BotToolNewCredential>
  topLevel?: (file: Readonly<Record<string, unknown>>) => Record<string, unknown>
}

/** As `changeBotToolServers`; the change can also set each server's extra keys, and `topLevel`
 *  the file's own keys beside `servers`. */
export function changeBotToolEntries(
  folder: string,
  change: (entries: BotToolEntry[]) => BotToolChange[],
  options: ChangeOptions = {}
): Promise<void> {
  return changeSnapshot(folder, (snapshot) => change(botToolEntries(snapshot)), options)
}

function changeSnapshot(
  folder: string,
  change: (snapshot: BotToolsSnapshot) => BotToolChange[],
  { expectedVersion, rename, credentials, topLevel }: ChangeOptions
): Promise<void> {
  return botToolCredentialsTransaction(folder, async () => {
    const snapshot = await readMigratedSnapshot(folder)
    if (expectedVersion !== undefined && expectedVersion !== snapshot.version) {
      throw stale()
    }
    const entries = change(snapshot)
    const file = topLevel
      ? { ...topLevel(snapshot.file), servers: snapshot.file.servers }
      : undefined
    await mkdir(dirname(botToolsPath(folder)), { recursive: true })
    if (writeServers(folder, snapshot, entries, { rename, credentials, file })) {
      advanceBotToolsEpoch(folder)
    }
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
  return ownTool(server, botToolCredentialsReader(folder).oauth)
}

/** `botOwnTool` for every server, from one read of the credential store. */
export function botOwnTools(servers: readonly BotToolServer[], folder: string): BotOwnTool[] {
  const readOAuth = botToolCredentialsReader(folder).oauth
  return servers.map((server) => ownTool(server, readOAuth))
}

function ownTool(
  server: BotToolServer,
  readOAuth: (id: string) => BotToolOAuthEntry | null
): BotOwnTool {
  const signIn =
    'url' in server && server.credential
      ? botToolSignInStatusOf(readOAuth(server.credential))
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
