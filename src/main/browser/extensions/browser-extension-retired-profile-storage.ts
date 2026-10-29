import { session } from 'electron'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { clearBrowserExtensionProfileSessionData } from './browser-extension-data-removal'

const RETIRED_PROFILES_FILE = 'retired-profile-storage.json'
const queuedThisRun = new Set<string>()
let cleanup: Promise<void> | null = null

function retiredProfilesPath(): string {
  return join(getBrowserExtensionInstallStore().root, RETIRED_PROFILES_FILE)
}

function readRetiredProfiles(): Set<string> {
  try {
    const raw: unknown = JSON.parse(readFileSync(retiredProfilesPath(), 'utf8'))
    if (
      !Array.isArray(raw) ||
      !raw.every(
        (value) => typeof value === 'string' && /^persist:orca-[A-Za-z0-9_-]+$/.test(value)
      )
    ) {
      throw new Error('Invalid retired extension profile partitions')
    }
    return new Set(raw)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return new Set()
    }
    throw error
  }
}

function writeRetiredProfiles(partitions: ReadonlySet<string>): void {
  const target = retiredProfilesPath()
  if (partitions.size === 0) {
    rmSync(target, { force: true })
  } else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileDurableSync(durableWriteTempPath(target), target, JSON.stringify([...partitions]))
  }
}

/** Chromium keeps native settings databases open until quit, including unloaded extensions. */
export async function retireBrowserExtensionProfileStorage(
  sess: Electron.Session,
  partition: string
): Promise<void> {
  try {
    const pending = readRetiredProfiles()
    pending.add(partition)
    writeRetiredProfiles(pending)
    queuedThisRun.add(partition)
  } finally {
    await clearBrowserExtensionProfileSessionData(sess)
  }
}

/** Runs even with extensions off, before a newly launched process opens their settings databases. */
export function removeRetiredBrowserExtensionProfileStorage(): Promise<void> {
  cleanup ??= (async () => {
    const pending = readRetiredProfiles()
    for (const partition of pending) {
      if (queuedThisRun.has(partition)) {
        continue
      }
      await clearBrowserExtensionProfileSessionData(session.fromPartition(partition))
      // Preserve retirements queued while asynchronous storage clearing was running.
      const current = readRetiredProfiles()
      current.delete(partition)
      writeRetiredProfiles(current)
    }
  })()
  return cleanup
}
