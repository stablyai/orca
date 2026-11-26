import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import type { CommanderAccount } from '../../shared/commander/memory-contract'
import { readInitializedActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { takeCloudSessionTicket } from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import { cloudConnectLinkEpoch } from '../orca-profiles/cloud-auth/profile-cloud-connect-attempts'
export function key(account: CommanderAccount): string {
  return JSON.stringify([account.profileId, account.userId, account.activeOrgId])
}

let authMutation = 0
export function noteRecoveryAccountChange(): void {
  authMutation++
}
export function changed(): Error {
  return new Error('Commander account changed.')
}

export async function principal() {
  const mutation = authMutation
  const link = cloudConnectLinkEpoch()
  const { profile, profileDirectory } =
    await readInitializedActiveOrcaProfile(getProfileUserDataPath())
  if (mutation !== authMutation || link !== cloudConnectLinkEpoch()) {
    throw changed()
  }
  if (!profile.cloud?.userId) {
    return null
  }
  const account = {
    profileId: profile.id,
    userId: profile.cloud.userId,
    activeOrgId: profile.cloud.activeOrgId ?? null
  }
  const directory = join(
    profileDirectory,
    'commander-recovery',
    createHash('sha256').update(key(account)).digest('hex')
  )
  const ticket = epoch(account)
  const again = (await readInitializedActiveOrcaProfile(getProfileUserDataPath())).profile
  if (
    again.id !== account.profileId ||
    again.cloud?.userId !== account.userId ||
    (again.cloud.activeOrgId ?? null) !== account.activeOrgId ||
    mutation !== authMutation ||
    ticket !== epoch(account)
  ) {
    throw changed()
  }
  return { account, directory, ticket }
}
export function isMissing(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT'
}
export async function readConsent(directory: string): Promise<string | null> {
  try {
    return z
      .string()
      .uuid()
      .parse(JSON.parse(await readFile(join(directory, 'enabled.json'), 'utf8')))
  } catch (e) {
    if (isMissing(e)) {
      return null
    }
    throw e
  }
}

export type Principal = NonNullable<Awaited<ReturnType<typeof principal>>>
export function epoch(account: CommanderAccount): string {
  const ticket = takeCloudSessionTicket(account.profileId, getProfileUserDataPath())
  return JSON.stringify([cloudConnectLinkEpoch(), ticket.linkVersion, ticket.generation])
}
