import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { ManagedSkillInstall, SkillPlacementResult } from '../../shared/skill-install-contract'
import { renameSkillPathWithWindowsRetry } from './skill-filesystem-retry'
import type { SkillInstalledFileMode } from './skill-install-filesystem'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'

export type SkillInstallReceiptV1 = {
  schemaVersion: 1
  packageId: string
  versionId: string
  packageDigest: string
  bundleDigest?: string
  archiveSha256: string
  scope: 'global' | 'workspace'
  destinationIdentity: string
  canonicalPath: string
  placements: SkillPlacementResult[]
  providers?: string[]
  previousVersionId?: string
  installedAt: string
  hostIdentity: string
  fileModes?: SkillInstalledFileMode[]
  wslDistro?: string
}

function normalizedSkillInstallPath(canonicalPath: string): string {
  const normalized = resolve(canonicalPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function skillInstallStateKey(canonicalPath: string): string {
  return createHash('sha256').update(normalizedSkillInstallPath(canonicalPath)).digest('hex')
}

export function skillInstallReceiptPath(stateDirectory: string, canonicalPath: string): string {
  return join(stateDirectory, 'receipts', `${skillInstallStateKey(canonicalPath)}.json`)
}

export async function writeSkillStateFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameSkillPathWithWindowsRetry(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function isReceipt(value: unknown): value is SkillInstallReceiptV1 {
  if (!value || typeof value !== 'object') {
    return false
  }
  const receipt = value as Partial<SkillInstallReceiptV1>
  return (
    receipt.schemaVersion === 1 &&
    typeof receipt.packageId === 'string' &&
    typeof receipt.versionId === 'string' &&
    typeof receipt.packageDigest === 'string' &&
    (receipt.bundleDigest === undefined || typeof receipt.bundleDigest === 'string') &&
    typeof receipt.archiveSha256 === 'string' &&
    (receipt.scope === 'global' || receipt.scope === 'workspace') &&
    typeof receipt.destinationIdentity === 'string' &&
    typeof receipt.canonicalPath === 'string' &&
    Array.isArray(receipt.placements) &&
    (receipt.providers === undefined ||
      (Array.isArray(receipt.providers) &&
        receipt.providers.every((provider) => typeof provider === 'string'))) &&
    typeof receipt.installedAt === 'string' &&
    typeof receipt.hostIdentity === 'string' &&
    (receipt.fileModes === undefined ||
      (Array.isArray(receipt.fileModes) &&
        receipt.fileModes.every(
          (file) => typeof file.path === 'string' && typeof file.executable === 'boolean'
        ))) &&
    (receipt.wslDistro === undefined || typeof receipt.wslDistro === 'string')
  )
}

export async function listManagedSkillInstalls(
  stateDirectory: string,
  options?: {
    observeReceipt?: (receipt: SkillInstallReceiptV1) => Promise<{ observedDigest: string } | null>
  }
): Promise<Omit<ManagedSkillInstall, 'destination'>[]> {
  const receiptsDirectory = join(stateDirectory, 'receipts')
  const entries = (await readdir(receiptsDirectory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .slice(0, 2048)
  const installs = await Promise.all(
    entries.map(async (entry): Promise<Omit<ManagedSkillInstall, 'destination'> | null> => {
      const parsed = await readFile(join(receiptsDirectory, entry.name), 'utf8')
        .then((value): unknown => JSON.parse(value))
        .catch(() => null)
      if (!isReceipt(parsed)) {
        return null
      }
      const observed = options?.observeReceipt
        ? await options.observeReceipt(parsed).catch(() => null)
        : await nativeSkillInstallFilesystem
            .observeSkill(parsed.canonicalPath, parsed.fileModes)
            .catch(() => null)
      return {
        name: basename(parsed.canonicalPath),
        packageId: parsed.packageId,
        versionId: parsed.versionId,
        packageDigest: parsed.packageDigest,
        ...(parsed.bundleDigest ? { bundleDigest: parsed.bundleDigest } : {}),
        scope: parsed.scope,
        destinationIdentity: parsed.destinationIdentity,
        installedAt: parsed.installedAt,
        ...(parsed.providers ? { providers: parsed.providers } : {}),
        state: observed
          ? observed.observedDigest === parsed.packageDigest
            ? 'unchanged'
            : 'modified'
          : 'missing'
      }
    })
  )
  return installs
    .filter((install): install is Omit<ManagedSkillInstall, 'destination'> => install !== null)
    .sort((left, right) => right.installedAt.localeCompare(left.installedAt))
}

export async function readSkillInstallReceipt(
  stateDirectory: string,
  canonicalPath: string
): Promise<SkillInstallReceiptV1 | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(skillInstallReceiptPath(stateDirectory, canonicalPath), 'utf8')
    )
    return isReceipt(parsed) &&
      normalizedSkillInstallPath(parsed.canonicalPath) === normalizedSkillInstallPath(canonicalPath)
      ? parsed
      : null
  } catch {
    return null
  }
}

export async function writeSkillInstallReceipt(
  stateDirectory: string,
  receipt: SkillInstallReceiptV1
): Promise<void> {
  await writeSkillStateFile(skillInstallReceiptPath(stateDirectory, receipt.canonicalPath), receipt)
}

export async function removeSkillInstallReceipt(
  stateDirectory: string,
  canonicalPath: string
): Promise<void> {
  await rm(skillInstallReceiptPath(stateDirectory, canonicalPath), { force: true })
}
