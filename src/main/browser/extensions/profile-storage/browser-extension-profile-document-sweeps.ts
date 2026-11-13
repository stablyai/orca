import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isChromeExtensionId } from '../../../../shared/browser/extensions/browser-extension-url'

/** Files a forget removes; queued with the writes so an older write can never land after it. */
export type SweepScope =
  | { kind: 'extension'; extensionId: string }
  | { kind: 'profileExtension'; profileId: string; extensionId: string }
  | { kind: 'profileExcept'; profileId: string; extensionIds: ReadonlySet<string> }
  | { kind: 'profile'; profileId: string }

export type Sweep = { scope: SweepScope; done: Promise<void>; settle: (error?: unknown) => void }

export function documentProfileDirectory(storageDirectory: string, profileId: string): string {
  return join(storageDirectory, encodeURIComponent(profileId))
}

export function documentFileName(extensionId: string): string {
  return `${encodeURIComponent(extensionId)}.json`
}

export function sweepCovers(sweep: SweepScope, profileId: string, extensionId: string): boolean {
  switch (sweep.kind) {
    case 'extension':
      return sweep.extensionId === extensionId
    case 'profileExtension':
      return sweep.profileId === profileId && sweep.extensionId === extensionId
    case 'profileExcept':
      return sweep.profileId === profileId && !sweep.extensionIds.has(extensionId)
    case 'profile':
      return sweep.profileId === profileId
  }
}

/** A missing directory has nothing to delete; any other read error fails the sweep. */
async function readdirIfPresent(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

const REMOVE_OPTIONS = { force: true, maxRetries: 3 }

export async function deleteSweptDocuments(
  sweep: SweepScope,
  storageDirectory: string
): Promise<void> {
  if (sweep.kind === 'profile') {
    await rm(documentProfileDirectory(storageDirectory, sweep.profileId), {
      ...REMOVE_OPTIONS,
      recursive: true
    })
    return
  }
  if (sweep.kind === 'profileExtension') {
    const directory = documentProfileDirectory(storageDirectory, sweep.profileId)
    await rm(join(directory, documentFileName(sweep.extensionId)), REMOVE_OPTIONS)
    return
  }
  if (sweep.kind === 'extension') {
    const profileDirectories = await readdirIfPresent(storageDirectory)
    await Promise.all(
      profileDirectories.map((directory) =>
        rm(join(storageDirectory, directory, documentFileName(sweep.extensionId)), REMOVE_OPTIONS)
      )
    )
    return
  }
  const directory = documentProfileDirectory(storageDirectory, sweep.profileId)
  const files = await readdirIfPresent(directory)
  await Promise.all(
    files.map((file) => {
      const extensionId = file.replace(/\.json$/, '')
      return isChromeExtensionId(extensionId) && !sweep.extensionIds.has(extensionId)
        ? rm(join(directory, file), REMOVE_OPTIONS)
        : undefined
    })
  )
}
