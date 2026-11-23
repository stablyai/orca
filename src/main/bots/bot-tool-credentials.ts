// A bot's tool credentials: each HTTP tool's real address with its saved headers, a source Orca fills
// per call, or Orca's own sign-in to the app. Each entry is sealed whole on the host, bound to its bot
// folder and id, so the bot's agent only ever gets Orca's relay address and its own token.
import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { writeSecureFile } from '../../shared/secure-storage/secure-file'
import type { BotToolServer } from '../../shared/bot-tools'
import { announceBotToolCredentialsEnded } from './bot-tool-credential-ended'
import {
  CredentialsFile,
  type Entry,
  openEntry,
  refuseUnsealedSecrets,
  sealEntry,
  warnOnce,
  type Stored
} from './bot-tool-credential-envelope'
import { announceIfShownChanged } from './bot-tool-sign-in-changed'
import {
  BotToolOAuthRecordSchema,
  type BotToolOAuthRecord
} from './tool-oauth/bot-tool-oauth-record'

export type { BotToolOAuthRecord }

/** Where the headers come from: saved values, or a source Orca fills per request (a hub's key). */
export type BotToolCredential = {
  url: string
  headers: Record<string, string>
  source?: string
}

/**
 * Orca's own sign-in to an app. `grant` names the sign-in: it changes when the account is replaced or
 * signed out, never when a token is refreshed. `revision` changes on every commit, tokens included.
 */
export type BotToolOAuthEntry = {
  url: string
  grant: number
  revision: number
  record: BotToolOAuthRecord
}

const OlderLayout = z.object({ credentials: z.record(z.string(), z.unknown()) })

let rootOverride: string | null = null

/** Tests point the store at a temporary folder. */
export function useBotToolCredentialsRoot(root: string | null): void {
  rootOverride = root
}

const credentialsRoot = (): string =>
  rootOverride ?? join(homedir(), '.orca', 'bot-tool-credentials')

export const botToolCredentialsPath = (folder: string): string =>
  join(
    credentialsRoot(),
    `${createHash('sha256').update(resolve(folder)).digest('hex').slice(0, 32)}.json`
  )

export const newBotToolCredentialId = (): string => randomBytes(12).toString('base64url')

function readFileText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The file's entries. A file in the older layout, with plaintext addresses beside separately sealed
 * values, is never opened: nothing vouches for its addresses, so its tools need signing in again.
 */
function parseStored(folder: string, text: string | null): Stored {
  if (text === null) {
    return {}
  }
  const json = parseJson(text)
  const parsed = CredentialsFile.safeParse(json)
  if (parsed.success) {
    return Object.fromEntries(
      Object.entries(parsed.data.credentials).map(([id, envelope]) => [
        id,
        { envelope, entry: openEntry(folder, id, envelope) }
      ])
    )
  }
  if (OlderLayout.safeParse(json).success) {
    warnOnce(text, '[bot-tool-credentials] ignored credentials saved in the older layout')
    return {}
  }
  throw new BotFailureError('toolCredentialsUnreadable')
}

const readSealed = (folder: string): Stored =>
  parseStored(folder, readFileText(botToolCredentialsPath(folder)))

const entryOf = (stored: Stored, id: string): Entry | null => stored[id]?.entry ?? null

/**
 * Publishes `next` only while the file still holds `expected`, so a write from another Orca on the
 * same home folder is never overwritten with what this one read before it. Answers whether it did.
 */
function publish(folder: string, expected: string | null, next: Stored): boolean {
  const path = botToolCredentialsPath(folder)
  const unchanged = () => readFileText(path) === expected
  if (Object.keys(next).length === 0) {
    if (!unchanged()) {
      return false
    }
    rmSync(path, { force: true })
    return true
  }
  const credentials = Object.fromEntries(
    Object.entries(next).map(([id, slot]) => [id, slot.envelope])
  )
  let published = false
  writeSecureFile(path, `${JSON.stringify({ version: 2, credentials }, null, 2)}\n`, {
    durable: true,
    shouldPublish: () => (published = unchanged())
  })
  return published
}

// One queue per folder for every write: the tools file and its credentials, sign-ins, refreshes and
// removals. A writer that waits on the network does so outside it and checks a revision inside it.
const queues = new Map<string, Promise<unknown>>()

/** Runs `work` after every earlier transaction on this folder's credentials has settled. */
export function botToolCredentialsTransaction<T>(folder: string, work: () => Promise<T> | T) {
  const key = resolve(folder)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  queues.set(key, next)
  void next
    .catch(() => undefined)
    .finally(() => {
      if (queues.get(key) === next) {
        queues.delete(key)
      }
    })
  return next
}

/** One header or source credential, opened and checked against its folder and id; null for none or a sign-in. */
export function readBotToolCredential(folder: string, id: string): BotToolCredential | null {
  const entry = entryOf(readSealed(folder), id)
  if (!entry || entry.kind === 'oauth') {
    return null
  }
  return {
    url: entry.url,
    ...(entry.kind === 'source' ? { source: entry.source } : {}),
    headers: { ...entry.headers }
  }
}

/** The sign-in a credential id holds, or null when it holds none or something else. */
export function readBotToolOAuth(folder: string, id: string): BotToolOAuthEntry | null {
  return oauthOf(entryOf(readSealed(folder), id))
}

function oauthOf(entry: Entry | null): BotToolOAuthEntry | null {
  if (entry?.kind !== 'oauth') {
    return null
  }
  const record = BotToolOAuthRecordSchema.safeParse(entry.record)
  return {
    url: entry.url,
    grant: entry.grant,
    revision: entry.revision,
    record: record.success ? record.data : { resource: entry.url }
  }
}

/**
 * Changes for an editor's stale check and the tools revision: saved values for headers, but only the
 * address and sign-in for an app Orca signs in to, so a refreshed token restarts no chat.
 */
export function botToolCredentialsFingerprint(folder: string, ids: ReadonlySet<string>): string {
  const sealed = readSealed(folder)
  return JSON.stringify(
    [...ids].sort().map((id) => {
      const slot = sealed[id]
      const entry = slot?.entry
      return [
        id,
        entry?.kind === 'oauth' ? [entry.kind, entry.url, entry.grant] : (slot?.envelope ?? null)
      ]
    })
  )
}

/** Header names only, for an editor that shows which values are saved. */
export function botToolCredentialHeaderNames(folder: string, id: string): string[] {
  const entry = entryOf(readSealed(folder), id)
  return entry && entry.kind !== 'oauth' ? Object.keys(entry.headers) : []
}

const signInManaged = () => new BotFailureError('toolSignInManaged')

/**
 * Adds `added` and drops `removed`, inside the folder's transaction; answers the sign-ins it dropped,
 * for the caller to revoke. Saved headers never replace a sign-in.
 */
export function changeBotToolCredentials(
  folder: string,
  added: ReadonlyMap<string, BotToolCredential>,
  removed: ReadonlySet<string> = new Set()
): BotToolOAuthEntry[] {
  if (added.size === 0 && removed.size === 0) {
    return []
  }
  refuseUnsealedSecrets(
    [...added.values()].some((credential) => Object.keys(credential.headers).length > 0)
  )
  const path = botToolCredentialsPath(folder)
  const text = readFileText(path)
  const current = parseStored(folder, text)
  for (const id of added.keys()) {
    if (current[id]?.entry?.kind === 'oauth') {
      throw signInManaged()
    }
  }
  const dropped = [...removed].flatMap((id) => {
    const entry = oauthOf(entryOf(current, id))
    return entry ? [entry] : []
  })
  const ended = [...removed].filter((id) => id in current)
  for (const id of removed) {
    delete current[id]
  }
  for (const [id, credential] of added) {
    const headers = { ...credential.headers }
    current[id] = sealEntry(
      folder,
      id,
      credential.source
        ? { kind: 'source', url: credential.url, source: credential.source, headers }
        : { kind: 'headers', url: credential.url, headers }
    )
  }
  if (!publish(folder, text, current)) {
    throw new BotFailureError('toolCredentialsRaced')
  }
  announceBotToolCredentialsEnded(folder, ended)
  return dropped
}

/**
 * Commits a sign-in in one step: `change` gets the stored entry (null when there is none) and answers
 * the next one, null to remove it, or `undefined` to leave it as it is. Each commit bumps the revision,
 * except a `statusOnly` one (no tokens change), so a refresh under way still commits its tokens.
 * Answers the entry as committed, or `undefined` when nothing was written.
 */
export function commitBotToolOAuth(
  folder: string,
  id: string,
  change: (
    current: BotToolOAuthEntry | null
  ) => { url: string; grant: number; record: BotToolOAuthRecord } | null | undefined,
  { statusOnly = false }: { statusOnly?: boolean } = {}
): BotToolOAuthEntry | null | undefined {
  const path = botToolCredentialsPath(folder)
  const text = readFileText(path)
  const stored = parseStored(folder, text)
  const existing = entryOf(stored, id)
  if (existing && existing.kind !== 'oauth') {
    throw signInManaged()
  }
  const current = oauthOf(existing)
  const next = change(current)
  if (next === undefined) {
    return undefined
  }
  const revision = (current?.revision ?? 0) + (statusOnly && current ? 0 : 1)
  if (next === null) {
    delete stored[id]
  } else {
    const record = BotToolOAuthRecordSchema.parse(next.record)
    refuseUnsealedSecrets(Boolean(record.tokens || record.client?.client_secret))
    stored[id] = sealEntry(folder, id, {
      kind: 'oauth',
      url: next.url,
      grant: next.grant,
      revision,
      record
    })
  }
  if (!publish(folder, text, stored)) {
    return undefined
  }
  if (current && (next === null || next.grant !== current.grant || next.url !== current.url)) {
    announceBotToolCredentialsEnded(folder, [id])
  }
  announceIfShownChanged(current, next)
  return next === null ? null : { ...next, revision }
}

/** A deleted bot's credentials; answers its sign-ins for the caller to revoke. */
export function forgetBotToolCredentials(folder: string): BotToolOAuthEntry[] {
  let ids: string[] = []
  let entries: BotToolOAuthEntry[] = []
  try {
    const stored = readSealed(folder)
    ids = Object.keys(stored)
    entries = Object.values(stored).flatMap((slot) => {
      const read = oauthOf(slot.entry)
      return read ? [read] : []
    })
  } catch {
    // An unreadable file still goes; there's nothing in it to revoke.
  }
  rmSync(botToolCredentialsPath(folder), { force: true })
  announceBotToolCredentialsEnded(folder, ids)
  return entries
}

/**
 * A stored tool as an edit starts from: its saved values and the address they're bound to, and a
 * credential id only for Orca's own sign-in, which the edit keeps.
 */
export function withSavedBotToolHeaders(folder: string, server: BotToolServer): BotToolServer {
  if (!('url' in server) || !server.credential) {
    return server
  }
  if (readBotToolOAuth(folder, server.credential)) {
    // Its tokens are Orca's own sign-in; a generic edit keeps the id and changes no values.
    return server
  }
  const { credential, ...rest } = server
  const saved = readBotToolCredential(folder, credential)
  if (saved?.source) {
    // Its headers come from a source Orca fills per call; a generic edit would drop them.
    throw new BotFailureError('toolSourceManaged')
  }
  return saved ? { ...rest, url: saved.url, headers: saved.headers } : rest
}
