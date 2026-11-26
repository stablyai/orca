import { createHash } from 'node:crypto'
import { access, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commanderAccount, type CommanderAccount } from '../../shared/commander/memory-contract'
import { readInitializedActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

async function activeSharing() {
  const { profile, profileDirectory } =
    await readInitializedActiveOrcaProfile(getProfileUserDataPath())
  if (!profile.cloud?.userId) {
    return null
  }
  const account = {
    profileId: profile.id,
    userId: profile.cloud.userId,
    activeOrgId: profile.cloud.activeOrgId ?? null
  }
  const key = createHash('sha256').update(JSON.stringify(account)).digest('hex')
  return { account, path: join(profileDirectory, `commander-phone-${key}`) }
}

async function isEnabled(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function matches(left: CommanderAccount, right: CommanderAccount): boolean {
  return (
    left.profileId === right.profileId &&
    left.userId === right.userId &&
    left.activeOrgId === right.activeOrgId
  )
}

export async function phoneMemoryStatus() {
  const active = await activeSharing()
  if (!active) {
    return { state: 'signed-out' as const }
  }
  if (!(await isEnabled(active.path))) {
    return { state: 'disabled' as const }
  }
  return {
    state: 'enabled' as const,
    account: active.account,
    handoffs: true as const,
    handoffSearch: true as const
  }
}

export async function requirePhoneMemory(account: CommanderAccount): Promise<void> {
  const status = await phoneMemoryStatus()
  if (status.state !== 'enabled' || !matches(status.account, account)) {
    throw new Error('Commander memory access changed. Reopen Memory on your phone.')
  }
}

export async function desktopPhoneSharing(expected: unknown, update?: unknown): Promise<boolean> {
  const active = await activeSharing()
  if (!active || !matches(active.account, commanderAccount.parse(expected))) {
    throw new Error('Commander account changed.')
  }
  if (update === true) {
    await writeFile(active.path, '', { mode: 0o600 })
  } else if (update === false) {
    await rm(active.path, { force: true })
  } else if (update !== undefined) {
    throw new Error('Invalid phone sharing preference.')
  }
  return isEnabled(active.path)
}
