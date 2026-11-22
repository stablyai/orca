import { readFile } from 'node:fs/promises'

export type SkillInstallLockOwner = {
  token: string
  pid: number
  createdAt: number
}

function validOwner(value: unknown): SkillInstallLockOwner | null {
  const owner = value as Partial<SkillInstallLockOwner> | null
  return owner &&
    typeof owner.token === 'string' &&
    typeof owner.pid === 'number' &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.createdAt === 'number'
    ? (owner as SkillInstallLockOwner)
    : null
}

export async function readSkillInstallLockOwner(
  path: string
): Promise<SkillInstallLockOwner | null> {
  try {
    return validOwner(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export function skillInstallLockOwnerProcessIsAlive(owner: SkillInstallLockOwner): boolean {
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
