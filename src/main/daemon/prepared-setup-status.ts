import { watch, type FSWatcher } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createOwnedStagingDirectory } from '../../shared/startup-command-staging'
import type { PreparedLaunchIncarnation } from '../../shared/prepared-agent-launch'

/** A missed watch event (network homes, WSL's /mnt view) still lands within this. */
const STATUS_POLL_MS = 2_000

export type SetupStatusObservation = {
  /** The file the Setup wrapper fills with `<attempt>:<status>`. */
  path: string
  /** Read now, e.g. on Setup output or exit; overlapping checks share one read. */
  check(): Promise<void>
  /** Stops reading and removes the directory, so a late writer has nowhere to write. */
  stop(): void
}

/**
 * Setup's exit status, out of band: the daemon owns the file, so completion needs no client
 * connected and nothing in the terminal. Only the bound attempt's record counts.
 */
export function observeSetupStatus(args: {
  owner?: PreparedLaunchIncarnation
  attemptId: string
  onStatus: (status: number) => void
  directory?: string
}): SetupStatusObservation {
  const directoryPath = createOwnedStagingDirectory({
    owner: args.owner,
    directory: args.directory
  })
  const path = join(directoryPath, 'setup-status')
  let stopped = false
  let reading: Promise<void> | undefined
  let watcher: FSWatcher | undefined
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    watcher?.close()
    clearInterval(timer)
    void rm(directoryPath, { recursive: true, force: true }).catch(() => {})
  }
  const read = async (): Promise<void> => {
    const text = await readFile(path, 'utf8').catch(() => undefined)
    const status = text === undefined ? undefined : parseSetupStatus(text, args.attemptId)
    if (status !== undefined && !stopped) {
      stop()
      args.onStatus(status)
    }
  }
  const check = (): Promise<void> => {
    if (stopped) {
      return Promise.resolve()
    }
    reading ??= read().finally(() => {
      reading = undefined
    })
    return reading
  }
  const timer = setInterval(() => void check(), STATUS_POLL_MS)
  timer.unref?.()
  try {
    watcher = watch(directoryPath, () => void check())
    watcher.on('error', () => watcher?.close())
  } catch {
    // The poll still reads it.
  }
  return { path, check, stop }
}

export function parseSetupStatus(text: string, attemptId: string): number | undefined {
  const match = /^([0-9a-f-]{36}):(-?\d{1,10})\r?\n?$/.exec(text)
  return match && match[1] === attemptId ? Number(match[2]) : undefined
}
