// The Microsoft Teams sign-in kept on this host, in Orca's encrypted credential files (an owner-only
// file where the OS keyring is missing, as for Google). Never sent to Orca Cloud, a phone or an SSH target.
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { inCredentialFileOrder } from '../credentials/credential-file-io'
import {
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../credentials/integration-credential-file'

export const TeamsAccountRecordSchema = z.object({
  tenantId: z.string().min(1),
  /** The Entra app this grant belongs to: a refresh must use it. */
  clientId: z.string().min(1),
  /** Graph's id for the person who signed in. */
  userId: z.string().min(1),
  name: z.string(),
  email: z.string().nullable(),
  channels: z.boolean(),
  /** Null once Microsoft ended the grant; the account stays for Reconnect. */
  refreshToken: z.string().min(1).nullable(),
  accessToken: z.string().min(1).nullable(),
  expiresAt: z.number(),
  grantedScopes: z.array(z.string()),
  status: z.enum(['connected', 'reconnect']),
  reason: z.string().optional(),
  connectedAt: z.number()
})

export type TeamsAccountRecord = z.infer<typeof TeamsAccountRecordSchema>

const teamsDir = () => join(homedir(), '.orca', 'teams')
const accountPath = () => join(teamsDir(), 'account.enc')
const lock = () => `${accountPath()}.mutation`

/** The saved sign-in; null when there is none, or this host can't read it (sign in again to replace it). */
export function readTeamsAccount(): Promise<TeamsAccountRecord | null> {
  return inCredentialFileOrder(lock(), async () => {
    let raw: Buffer
    try {
      raw = await readFile(accountPath())
    } catch {
      return null
    }
    try {
      const text = readStoredCredentialToken('Microsoft Teams', raw)
      return text === null
        ? null
        : (TeamsAccountRecordSchema.safeParse(JSON.parse(text)).data ?? null)
    } catch {
      return null
    }
  })
}

/** With `expectedRefreshToken`, saves only over the grant a refresh started from. */
export function saveTeamsAccount(
  record: TeamsAccountRecord,
  expectedRefreshToken?: string
): Promise<void> {
  return inCredentialFileOrder(lock(), async () => {
    if (expectedRefreshToken !== undefined) {
      const raw = await readFile(accountPath()).catch(() => null)
      const text = raw ? readStoredCredentialToken('Microsoft Teams', raw) : null
      const current = text ? TeamsAccountRecordSchema.safeParse(JSON.parse(text)).data : null
      if (current?.refreshToken !== expectedRefreshToken) {
        return
      }
    }
    await mkdir(teamsDir(), { recursive: true, mode: 0o700 })
    await writeEncryptedCredential('Microsoft Teams', accountPath(), JSON.stringify(record))
  })
}

export function removeTeamsAccount(): Promise<void> {
  return inCredentialFileOrder(lock(), async () => {
    await unlink(accountPath()).catch(() => undefined)
  })
}
