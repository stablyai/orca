// One sealed entry of a bot's tool credentials: the whole entry, bound to the bot folder and id it
// belongs to, so editing the credentials file can't re-point a value or move it to another tool or bot.
import { resolve } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import { getSecretStore, hasSecretStore } from '../../shared/secure-storage/secret-store'

const Envelope = lazyZodSchema(() => z.string().regex(/^(?:sealed|plain):[A-Za-z0-9+/=]*$/))
const Headers = lazyZodSchema(() => z.record(z.string(), z.string()))
export const Entry = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('headers'), url: z.string(), headers: Headers }),
    z.object({ kind: z.literal('source'), url: z.string(), source: z.string(), headers: Headers }),
    z.object({
      kind: z.literal('oauth'),
      url: z.string(),
      grant: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
      // Parsed on its own: an unreadable sign-in is one to make again, never a missing tool.
      record: z.unknown()
    })
  ])
)
export type Entry = z.infer<typeof Entry>
/** What one envelope seals: the whole entry with the folder and id it belongs to. */
const SealedEntry = lazyZodSchema(() =>
  z.object({ folder: z.string(), id: z.string(), entry: Entry })
)
const CredentialsFile = lazyZodSchema(() =>
  z.object({
    version: z.literal(2),
    credentials: z.record(z.string(), Envelope)
  })
)
const OlderLayout = lazyZodSchema(() =>
  z.object({ credentials: z.record(z.string(), z.unknown()) })
)
/** An entry as read: its envelope, kept as written, and what it holds, null when it doesn't open here. */
export type Slot = { envelope: string; entry: Entry | null }
export type Stored = Record<string, Slot>

const canSeal = (): boolean => hasSecretStore() && getSecretStore().isEncryptionAvailable()

function seal(value: string): string {
  if (canSeal()) {
    return `sealed:${getSecretStore().encryptString(value).toString('base64')}`
  }
  // No OS keyring: owner-only plaintext, which holds no saved secret (see refuseUnsealedSecrets).
  return `plain:${Buffer.from(value, 'utf8').toString('base64')}`
}

/** An envelope's text; a `plain:` one only where nothing can be sealed, since anyone can write one. */
function unseal(envelope: string): string {
  const [kind, payload = ''] = envelope.split(':', 2)
  const bytes = Buffer.from(payload, 'base64')
  if (kind !== 'plain') {
    return getSecretStore().decryptString(bytes)
  }
  if (canSeal()) {
    throw new Error('unsealed credential on a host that seals')
  }
  return bytes.toString('utf8')
}

/** Without an OS keyring a sealed value would sit in plaintext the bot's agent can read: refuse it. */
export function refuseUnsealedSecrets(hasSecret: boolean): void {
  if (hasSecret && !canSeal()) {
    throw new Error(
      'Orca can’t lock saved tool values on this computer because it has no system keyring, so it won’t save them.'
    )
  }
}

export function sealEntry(folder: string, id: string, entry: Entry): Slot {
  return { envelope: seal(JSON.stringify({ folder: resolve(folder), id, entry })), entry }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The file's envelopes, still sealed. A file in the older layout, with plaintext addresses beside
 * separately sealed values, is never opened: nothing vouches for its addresses, so its tools need
 * signing in again.
 */
export function parseEnvelopes(text: string | null): Record<string, string> {
  if (text === null) {
    return {}
  }
  const json = parseJson(text)
  const parsed = CredentialsFile.safeParse(json)
  if (parsed.success) {
    return parsed.data.credentials
  }
  if (OlderLayout.safeParse(json).success) {
    warnOnce(text, '[bot-tool-credentials] ignored credentials saved in the older layout')
    return {}
  }
  throw new BotFailureError('toolCredentialsUnreadable')
}

/** The entry an envelope holds, only when it was sealed for this folder and id. */
export function openEntry(folder: string, id: string, envelope: string): Entry | null {
  try {
    const opened = SealedEntry.safeParse(JSON.parse(unseal(envelope)))
    if (opened.success && opened.data.folder === resolve(folder) && opened.data.id === id) {
      return opened.data.entry
    }
  } catch {
    // Unreadable here, below.
  }
  warnOnce(envelope, '[bot-tool-credentials] ignored a credential that does not open for its tool')
  return null
}

// Reads repeat on every tools check; one line per ignored file or entry is enough.
const warned = new Set<string>()
export function warnOnce(key: string, message: string): void {
  if (!warned.has(key)) {
    warned.add(key)
    console.warn(message)
  }
}
