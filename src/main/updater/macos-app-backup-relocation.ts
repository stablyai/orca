import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

const LEGACY_APPLICATION_BACKUP = /^Orca\.app\.backup-(.+)$/
const LEGACY_USER_DATA_BACKUP = /^Orca-(.+)\.app$/
const BACKUP_DIRECTORY = 'installer-backups.noindex'

type BackupSource = {
  path: string
  name: string
}

export type MacAppBackupRelocationDeps = {
  applicationsDir: string
  userDataDir: string
  move?: (source: string, destination: string) => Promise<void>
}

export type MacAppBackupRelocationResult = {
  moved: string[]
  skipped: string[]
}

async function backupSources(
  directory: string,
  patterns: readonly RegExp[]
): Promise<BackupSource[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && patterns.some((pattern) => pattern.test(entry.name)))
    .map((entry) => ({ path: join(directory, entry.name), name: entry.name }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function backupName(sourceName: string): string {
  const applicationMatch = LEGACY_APPLICATION_BACKUP.exec(sourceName)
  if (applicationMatch) {
    return `backup-${applicationMatch[1]}`
  }
  const userDataMatch = LEGACY_USER_DATA_BACKUP.exec(sourceName)
  return `backup-${userDataMatch?.[1] ?? sourceName}`
}

function availableName(baseName: string, reservedNames: Set<string>): string {
  if (!reservedNames.has(baseName)) {
    return baseName
  }
  let suffix = 2
  while (reservedNames.has(`${baseName}-${suffix}`)) {
    suffix += 1
  }
  return `${baseName}-${suffix}`
}

/** Moves legacy app bundles out of searchable locations without deleting recoverable backups. */
export async function relocateMacAppBackups({
  applicationsDir,
  userDataDir,
  move = rename
}: MacAppBackupRelocationDeps): Promise<MacAppBackupRelocationResult> {
  const legacyUserDataDir = join(userDataDir, 'backups')
  const sources = [
    ...(await backupSources(legacyUserDataDir, [
      LEGACY_USER_DATA_BACKUP,
      LEGACY_APPLICATION_BACKUP
    ])),
    ...(await backupSources(applicationsDir, [LEGACY_APPLICATION_BACKUP]))
  ]
  if (sources.length === 0) {
    return { moved: [], skipped: [] }
  }

  const destinationDir = join(userDataDir, BACKUP_DIRECTORY)
  await mkdir(destinationDir, { recursive: true })
  const reservedNames = new Set(await readdir(destinationDir).catch(() => []))
  const moved: string[] = []
  const skipped: string[] = []
  for (const source of sources) {
    const name = availableName(backupName(source.name), reservedNames)
    try {
      await move(source.path, join(destinationDir, name))
      reservedNames.add(name)
      moved.push(name)
    } catch {
      skipped.push(source.name)
    }
  }
  return { moved, skipped }
}

export function relocateThisProcessMacAppBackups(
  userDataDir: string
): Promise<MacAppBackupRelocationResult> | null {
  if (process.platform !== 'darwin' || !process.execPath.includes('.app/Contents/MacOS/')) {
    return null
  }
  return relocateMacAppBackups({ applicationsDir: '/Applications', userDataDir })
}
