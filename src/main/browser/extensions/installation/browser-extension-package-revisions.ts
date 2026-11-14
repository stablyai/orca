import { writeBrowserExtensionGeneratedFile } from './browser-extension-generated-files'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { cp, link, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import {
  withPrivateFilesHiddenFromWebAccessibleResources,
  withStaticWebAccessibleResources
} from './browser-extension-web-accessible-resources'

export type BrowserExtensionPackageRevision = {
  id: string
  sourcePath: string
  directory: string
  extensionId: string
  references: number
  originalManifest: string
  manifest: Record<string, unknown>
  files: string[]
  directories: string[]
  icons: Map<string, Promise<string | null>>
}

const current = new Map<string, BrowserExtensionPackageRevision>()
const currentBySource = new Map<string, BrowserExtensionPackageRevision>()
const pending = new Map<string, Promise<BrowserExtensionPackageRevision>>()
const executions = new Map<string, BrowserExtensionPackageRevision>()
const cleanup = new Set<string>()
let runDirectory: Promise<string> | undefined

async function removeOwnedDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    cleanup.delete(directory)
  } catch (error) {
    cleanup.add(directory)
    console.warn('[browser-extensions] Could not remove execution cache:', error)
  }
}

function getRunDirectory(): Promise<string> {
  runDirectory ??= (async () => {
    const root = join(getBrowserExtensionInstallStore().root, 'execution-cache')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'run-'))
    // The app lock protects this user-data root; cleanup never gates a new generation.
    if (app.hasSingleInstanceLock()) {
      void (async () => {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          const previous = join(root, entry.name)
          if (
            previous !== directory &&
            entry.isDirectory() &&
            /^run-[a-zA-Z0-9]+$/.test(entry.name)
          ) {
            await removeOwnedDirectory(previous)
          }
        }
      })().catch((error: unknown) =>
        console.warn('[browser-extensions] Could not inspect execution cache:', error)
      )
    }
    app.once('will-quit', () => {
      void Promise.all([...cleanup, directory].map(removeOwnedDirectory))
    })
    return directory
  })()
  return runDirectory
}

function releaseRevision(revision: BrowserExtensionPackageRevision): void {
  if (--revision.references === 0) {
    revision.icons.clear()
    void removeOwnedDirectory(revision.directory)
  }
}

/** Immutable originals only; a refresh selects another revision without changing live files. */
export async function acquireBrowserExtensionPackageRevision(
  extension: Pick<InstalledBrowserExtension, 'id' | 'path'>,
  originalManifest: string,
  excludedNames: ReadonlySet<string>,
  refresh = false
): Promise<BrowserExtensionPackageRevision> {
  const key = resolve(extension.path)
  const existing = current.get(extension.id)
  if (existing && !refresh && existing.sourcePath === key) {
    return existing
  }
  let creating = pending.get(key)
  if (!creating) {
    creating = (async () => {
      const directory = join(await getRunDirectory(), `revision-${randomUUID()}`)
      try {
        const store = getBrowserExtensionInstallStore()
        const installed = store.get(extension.id)
        const owned =
          installed?.source === 'webstore' &&
          resolve(installed.path) === key &&
          key === resolve(store.installDirectory(installed.id, installed.version))
        await (owned
          ? copyImmutablePackage(extension.path, directory, excludedNames)
          : cp(extension.path, directory, {
              recursive: true,
              dereference: true,
              filter: (source) =>
                !relative(extension.path, source)
                  .split(/[\\/]/)
                  .some((part) => part === '.git' || excludedNames.has(part))
            }))
        await writeBrowserExtensionGeneratedFile(join(directory, 'manifest.json'), originalManifest)
        const entries = await readdir(directory, { recursive: true, withFileTypes: true })
        const files = entries
          .filter((entry) => entry.isFile())
          .map((entry) =>
            relative(directory, join(entry.parentPath, entry.name)).split(/[\\/]/).join('/')
          )
        const directories = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
          .sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length)
        const manifest = withPrivateFilesHiddenFromWebAccessibleResources(
          withStaticWebAccessibleResources(JSON.parse(originalManifest)),
          files,
          () => false
        )
        const revision = {
          id: randomUUID(),
          sourcePath: key,
          directory,
          extensionId: extension.id,
          references: 1,
          originalManifest,
          manifest,
          files,
          directories,
          icons: new Map<string, Promise<string | null>>()
        }
        const previous = current.get(extension.id)
        current.set(extension.id, revision)
        currentBySource.set(key, revision)
        if (previous) {
          if (previous.sourcePath !== key) {
            currentBySource.delete(previous.sourcePath)
          }
          releaseRevision(previous)
        }
        return revision
      } catch (error) {
        await removeOwnedDirectory(directory)
        throw error
      }
    })()
    pending.set(key, creating)
  }
  try {
    return await creating
  } finally {
    if (pending.get(key) === creating) {
      pending.delete(key)
    }
  }
}

/** Each tree owns its entries; only immutable ordinary assets share file bytes. */
export async function materializeBrowserExtensionExecution(
  revision: BrowserExtensionPackageRevision,
  signal?: AbortSignal
): Promise<{ directory: string; release: () => Promise<void> }> {
  revision.references++
  const directory = join(await getRunDirectory(), `execution-${randomUUID()}`)
  try {
    await mkdir(directory)
    for (const relativeDirectory of revision.directories) {
      signal?.throwIfAborted()
      await mkdir(join(directory, relativeDirectory))
    }
    for (const file of revision.files) {
      signal?.throwIfAborted()
      const source = join(revision.directory, file)
      const target = join(directory, file)
      await (file === 'manifest.json' ? cp(source, target) : linkOrCopy(source, target))
    }
    signal?.throwIfAborted()
    executions.set(directory, revision)
  } catch (error) {
    await removeOwnedDirectory(directory)
    releaseRevision(revision)
    throw error
  }
  let released = false
  return {
    directory,
    release: async () => {
      if (released) {
        return
      }
      released = true
      executions.delete(directory)
      await removeOwnedDirectory(directory)
      releaseRevision(revision)
    }
  }
}

export function getBrowserExtensionPackageRevision(
  executionDirectory: string
): BrowserExtensionPackageRevision | undefined {
  return executions.get(executionDirectory)
}

export function getCurrentBrowserExtensionPackageRevision(
  sourcePath: string
): BrowserExtensionPackageRevision | undefined {
  return currentBySource.get(resolve(sourcePath))
}

export function forgetBrowserExtensionPackageRevision(extensionId: string): void {
  const revision = current.get(extensionId)
  current.delete(extensionId)
  if (revision) {
    currentBySource.delete(revision.sourcePath)
    releaseRevision(revision)
  }
}

async function linkOrCopy(source: string, target: string): Promise<void> {
  try {
    await link(source, target)
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error) ||
      !['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(String(error.code))
    ) {
      throw error
    }
    await cp(source, target)
  }
}

async function copyImmutablePackage(
  source: string,
  target: string,
  excluded: ReadonlySet<string>
): Promise<void> {
  await mkdir(target)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '.git' || excluded.has(entry.name)) {
      continue
    }
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      await copyImmutablePackage(from, to, excluded)
    } else if (entry.isFile() && entry.name !== 'manifest.json') {
      await linkOrCopy(from, to)
    } else {
      await cp(from, to, { recursive: true, dereference: true })
    }
  }
}
