import { inCredentialFileOrder, credentialFileExists } from '../credentials/credential-file-io'
// This host's Google client and each Google account signed in on it, in Orca's encrypted credential
// files (an owner-only file where the OS keyring is missing, as for Linear). Never sent to Orca Cloud,
// a paired phone or an SSH target.
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  GoogleClientConfigSchema,
  type GoogleClientConfig
} from '../../shared/google/google-client-config'
import { GOOGLE_SERVICE_CHOICES, GOOGLE_SERVICES } from '../../shared/google/google-scopes'
import {
  CredentialDecryptionError,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../credentials/integration-credential-file'

const ServiceReadinessSchema = z.object({
  service: z.enum(GOOGLE_SERVICES),
  state: z.enum(['ready', 'needs-permission', 'api-disabled', 'blocked-by-admin', 'error']),
  detail: z.string().optional(),
  enableUrl: z.string().optional()
})

export const GoogleAccountRecordSchema = z.object({
  /** The account's key here (`--account`, and later a trigger rule's account). */
  email: z.string().min(1),
  /** Google's stable id for the account, which outlives an address change. */
  sub: z.string().min(1).optional(),
  /** The client this grant belongs to: a refresh must use it, whatever client is saved now. */
  client: z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }),
  projectId: z.string().optional(),
  /** Null once Google ended the grant; the account stays listed for Reconnect. */
  refreshToken: z.string().min(1).nullable(),
  accessToken: z.string().min(1).nullable(),
  expiresAt: z.number(),
  grantedScopes: z.array(z.string()),
  /** What the person picked at Connect; a picked service Google didn't grant shows Needs permission. */
  choices: z.array(z.enum(GOOGLE_SERVICE_CHOICES)).optional(),
  status: z.enum(['connected', 'reconnect']),
  reason: z.string().optional(),
  services: z.array(ServiceReadinessSchema),
  checkedAt: z.number().optional(),
  connectedAt: z.number()
})

export type GoogleAccountRecord = z.infer<typeof GoogleAccountRecordSchema>

const googleDir = () => join(homedir(), '.orca', 'google')
const clientPath = () => join(googleDir(), 'client.enc')
const accountsDir = () => join(googleDir(), 'accounts')
const defaultAccountPath = () => join(googleDir(), 'default-account.enc')
const accountPath = (email: string) =>
  join(accountsDir(), `${Buffer.from(email.toLowerCase()).toString('base64url')}.enc`)

type Read<T> = { value: T | null } | { unreadable: string }

/** A file this host can't decrypt (Keychain denied, another secret store) is reported, not thrown. */
async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<Read<T>> {
  let raw: Buffer
  try {
    raw = await readFile(path)
  } catch {
    return { value: null }
  }
  try {
    const text = readStoredCredentialToken('Google', raw)
    return { value: text === null ? null : (schema.safeParse(JSON.parse(text)).data ?? null) }
  } catch (error) {
    return error instanceof CredentialDecryptionError
      ? { unreadable: error.message }
      : { value: null }
  }
}

const valueOf = <T>(read: Read<T>): T | null => ('value' in read ? read.value : null)

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // Nothing saved.
  }
}

export async function saveImportedGoogleClient(config: GoogleClientConfig): Promise<void> {
  return inCredentialFileOrder(`${clientPath()}.mutation`, async () => {
    await mkdir(googleDir(), { recursive: true, mode: 0o700 })
    await writeEncryptedCredential('Google', clientPath(), JSON.stringify(config))
  })
}

/** The client new sign-ins use: the file imported on this host (one this host can't read is none; import it again). */
export async function resolveGoogleClient(): Promise<GoogleClientConfig | null> {
  return inCredentialFileOrder(`${clientPath()}.mutation`, async () =>
    valueOf(await readJson(clientPath(), GoogleClientConfigSchema))
  )
}

export async function saveGoogleAccount(
  record: GoogleAccountRecord,
  expectedRefreshToken?: string
): Promise<void> {
  return inCredentialFileOrder(`${accountsDir()}.mutation`, async () => {
    if (
      expectedRefreshToken !== undefined &&
      valueOf(await readJson(accountPath(record.email), GoogleAccountRecordSchema))
        ?.refreshToken !== expectedRefreshToken
    ) {
      return
    }
    await mkdir(accountsDir(), { recursive: true, mode: 0o700 })
    await writeEncryptedCredential('Google', accountPath(record.email), JSON.stringify(record))
  })
}

/** The saved account; null when there is none or this host can't read it, so a new sign-in replaces it. */
export async function readGoogleAccount(email: string): Promise<GoogleAccountRecord | null> {
  return inCredentialFileOrder(`${accountsDir()}.mutation`, async () =>
    valueOf(await readJson(accountPath(email), GoogleAccountRecordSchema))
  )
}

/** Each saved account, or why this host can't read it (named from its file). */
export type GoogleAccountEntry =
  | { email: string; record: GoogleAccountRecord }
  | { email: string; unreadable: string }

export async function listGoogleAccounts(): Promise<GoogleAccountEntry[]> {
  return inCredentialFileOrder(`${accountsDir()}.mutation`, listAccounts)
}

async function listAccounts(): Promise<GoogleAccountEntry[]> {
  let names: string[]
  try {
    names = await readdir(accountsDir())
  } catch {
    return []
  }
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith('.enc'))
      .map(async (name): Promise<GoogleAccountEntry[]> => {
        const email = Buffer.from(name.slice(0, -'.enc'.length), 'base64url').toString('utf-8')
        const read = await readJson(join(accountsDir(), name), GoogleAccountRecordSchema)
        if ('unreadable' in read) {
          return [{ email, unreadable: read.unreadable }]
        }
        return read.value ? [{ email: read.value.email, record: read.value }] : []
      })
  )
  return entries.flat().sort((a, b) => connectedAt(a) - connectedAt(b))
}

const connectedAt = (entry: GoogleAccountEntry) =>
  'record' in entry ? entry.record.connectedAt : Number.MAX_SAFE_INTEGER

export async function hasGoogleAccount(email: string): Promise<boolean> {
  return inCredentialFileOrder(`${accountsDir()}.mutation`, () =>
    credentialFileExists(accountPath(email))
  )
}

export async function removeGoogleAccount(email: string): Promise<void> {
  return inCredentialFileOrder(`${accountsDir()}.mutation`, async () => {
    await removeFile(accountPath(email))
  })
}

const DefaultAccountSchema = z.object({ email: z.string().min(1) })

/** The saved pick while that account is still here, else the oldest; null with no account. */
function pickGoogleDefaultAccount(emails: readonly string[], saved: string | null): string | null {
  const wanted = saved?.toLowerCase()
  return emails.find((email) => email.toLowerCase() === wanted) ?? emails[0] ?? null
}

/**
 * The account calls and triggers without `--account` use. A host without a saved pick (the first
 * sign-in, an upgrade, or its default removed) takes the oldest and keeps it, so a later sign-in or
 * reconnect never moves it.
 */
export async function resolveGoogleDefaultAccount(): Promise<string | null> {
  return inCredentialFileOrder(`${accountsDir()}.mutation`, async () => {
    const emails = (await listAccounts()).map((entry) => entry.email)
    const saved = valueOf(await readJson(defaultAccountPath(), DefaultAccountSchema))?.email ?? null
    const picked = pickGoogleDefaultAccount(emails, saved)
    if (picked && picked.toLowerCase() !== saved?.toLowerCase()) {
      await writeEncryptedCredential(
        'Google',
        defaultAccountPath(),
        JSON.stringify({ email: picked })
      )
    }
    return picked
  })
}

export async function saveGoogleDefaultAccount(email: string): Promise<string> {
  return inCredentialFileOrder(`${accountsDir()}.mutation`, async () => {
    const picked = (await listAccounts()).find(
      (entry) => entry.email.toLowerCase() === email.toLowerCase()
    )
    if (!picked) {
      throw new Error(`${email} isn't connected on this computer.`)
    }
    await mkdir(googleDir(), { recursive: true, mode: 0o700 })
    await writeEncryptedCredential(
      'Google',
      defaultAccountPath(),
      JSON.stringify({ email: picked.email })
    )
    return picked.email
  })
}
