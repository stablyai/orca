// This host's Google client and each Google account signed in on it, in Orca's encrypted credential
// files (an owner-only file where the OS keyring is missing, as for Linear). Never sent to Orca Cloud,
// a paired phone or an SSH target.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
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
const accountPath = (email: string) =>
  join(accountsDir(), `${Buffer.from(email.toLowerCase()).toString('base64url')}.enc`)

type Read<T> = { value: T | null } | { unreadable: string }

/** A file this host can't decrypt (Keychain denied, another secret store) is reported, not thrown. */
function readJson<T>(path: string, schema: z.ZodType<T>): Read<T> {
  let raw: Buffer
  try {
    raw = readFileSync(path)
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

function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Nothing saved.
  }
}

export function saveImportedGoogleClient(config: GoogleClientConfig): void {
  mkdirSync(googleDir(), { recursive: true, mode: 0o700 })
  writeEncryptedCredential('Google', clientPath(), JSON.stringify(config))
}

/** The client new sign-ins use: the file imported on this host (one this host can't read is none; import it again). */
export function resolveGoogleClient(): GoogleClientConfig | null {
  return valueOf(readJson(clientPath(), GoogleClientConfigSchema))
}

export function saveGoogleAccount(record: GoogleAccountRecord): void {
  mkdirSync(accountsDir(), { recursive: true, mode: 0o700 })
  writeEncryptedCredential('Google', accountPath(record.email), JSON.stringify(record))
}

/** The saved account; null when there is none or this host can't read it, so a new sign-in replaces it. */
export function readGoogleAccount(email: string): GoogleAccountRecord | null {
  return valueOf(readJson(accountPath(email), GoogleAccountRecordSchema))
}

/** Each saved account, or why this host can't read it (named from its file). */
export type GoogleAccountEntry =
  | { email: string; record: GoogleAccountRecord }
  | { email: string; unreadable: string }

export function listGoogleAccounts(): GoogleAccountEntry[] {
  let names: string[]
  try {
    names = readdirSync(accountsDir())
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.enc'))
    .flatMap((name): GoogleAccountEntry[] => {
      const email = Buffer.from(name.slice(0, -'.enc'.length), 'base64url').toString('utf-8')
      const read = readJson(join(accountsDir(), name), GoogleAccountRecordSchema)
      if ('unreadable' in read) {
        return [{ email, unreadable: read.unreadable }]
      }
      return read.value ? [{ email: read.value.email, record: read.value }] : []
    })
    .sort((a, b) => connectedAt(a) - connectedAt(b))
}

const connectedAt = (entry: GoogleAccountEntry) =>
  'record' in entry ? entry.record.connectedAt : Number.MAX_SAFE_INTEGER

export function hasGoogleAccount(email: string): boolean {
  return existsSync(accountPath(email))
}

export function removeGoogleAccount(email: string): void {
  removeFile(accountPath(email))
}
