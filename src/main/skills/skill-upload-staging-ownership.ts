import { randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const OWNER_DIRECTORY_PREFIX = 'owner-'
const OWNER_DIRECTORY_PATTERN =
  /^owner-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const STAGING_ENTRY_SCAN_LIMIT = 64

export const SKILL_UPLOAD_STAGING_ROOT_NAME = 'remote-uploads-v2'

export type SkillUploadStagingOwnershipOptions = {
  processIsAlive?: (pid: number) => boolean
}

export class SkillUploadStagingOwnership {
  readonly directory: string
  private readonly processIsAlive: (pid: number) => boolean

  constructor(
    private readonly root: string,
    options: SkillUploadStagingOwnershipOptions = {}
  ) {
    this.directory = join(root, `${OWNER_DIRECTORY_PREFIX}${process.pid}-${randomUUID()}`)
    this.processIsAlive = options.processIsAlive ?? processIsAlive
  }

  async initialize(initializeRoot?: () => Promise<void>): Promise<void> {
    await (initializeRoot ? initializeRoot() : mkdir(this.root, { recursive: true, mode: 0o700 }))
    const rootStats = await lstat(this.root)
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error('skill-upload-staging-root-invalid')
    }
    await this.cleanupAbandonedOwners()
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
  }

  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true })
  }

  private async cleanupAbandonedOwners(): Promise<void> {
    const root = await opendir(this.root)
    let visited = 0
    try {
      for await (const entry of root) {
        visited += 1
        if (visited > STAGING_ENTRY_SCAN_LIMIT) {
          throw new Error('skill-upload-staging-entry-limit')
        }
        const ownerPid = parseOwnerPid(entry.name)
        if (!entry.isDirectory() || ownerPid === null || this.processIsAlive(ownerPid)) {
          continue
        }
        const candidate = join(this.root, entry.name)
        const stats = await lstat(candidate).catch(() => null)
        if (stats?.isDirectory() && !stats.isSymbolicLink()) {
          await rm(candidate, { recursive: true, force: true })
        }
      }
    } finally {
      await root.close().catch(() => undefined)
    }
  }
}

function parseOwnerPid(name: string): number | null {
  const match = OWNER_DIRECTORY_PATTERN.exec(name)
  if (!match) {
    return null
  }
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
