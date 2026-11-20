// One sealed entry of a bot's tool credentials: the whole entry, bound to the bot folder and id it
// belongs to, so editing the credentials file can't re-point a value or move it to another tool or bot.
import { resolve } from 'node:path'
import { z } from 'zod'
import { getSecretStore, hasSecretStore } from '../../shared/secure-storage/secret-store'

const Envelope = z.string().regex(/^(?:sealed|plain):[A-Za-z0-9+/=]*$/)
const Headers = z.record(z.string(), z.string())
export const Entry = z.discriminatedUnion('kind', [
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
export type Entry = z.infer<typeof Entry>
/** What one envelope seals: the whole entry with the folder and id it belongs to. */
const SealedEntry = z.object({ folder: z.string(), id: z.string(), entry: Entry })
export const CredentialsFile = z.object({
  version: z.literal(2),
  credentials: z.record(z.string(), Envelope)
})
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
