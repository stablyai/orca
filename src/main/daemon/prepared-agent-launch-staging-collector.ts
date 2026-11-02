import { readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBootIdentity } from '../agent-hooks/managed-hook-owner-identity'
import {
  OWNED_STAGING_READER_FILE,
  OWNED_STAGING_WRITER_FILE,
  OWNED_STAGING_WRITER_PREFIX,
  ownedStagingBootTag,
  sweepPriorBootOwnedStaging
} from '../../shared/startup-command-staging'
import { inspectProcessSignal } from './daemon-process-inspection'
import {
  isPreparedLaunchIncarnationGone,
  parsePreparedLaunchIncarnation
} from './prepared-agent-launch-incarnation'

const collecting = new Map<string, Promise<void>>()

/**
 * Collect owned launch files nothing can still read: from an earlier boot, or staged without a
 * boot whose writer daemon exited and whose shell reader is gone or was never named. Runs at
 * daemon start and each main reconnect; unavailable evidence keeps the file for the next run.
 */
export function collectOwnedStartupStaging(directory = tmpdir()): Promise<void> {
  const existing = collecting.get(directory)
  if (existing) {
    return existing
  }
  const run = collect(directory)
    .catch(() => {})
    .finally(() => collecting.delete(directory))
  collecting.set(directory, run)
  return run
}

async function collect(directory: string): Promise<void> {
  const boot = await readBootIdentity().catch(() => undefined)
  if (boot) {
    sweepPriorBootOwnedStaging({ directory, bootTag: ownedStagingBootTag(boot) })
  }
  const writers = new Map<string, Promise<boolean>>()
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.startsWith(OWNED_STAGING_WRITER_PREFIX)) {
      continue
    }
    const path = join(directory, name)
    const writer = parseWriter(
      await readFile(join(path, OWNED_STAGING_WRITER_FILE), 'utf8').catch(() => '')
    )
    if (!writer) {
      continue
    }
    const key = JSON.stringify(writer)
    const writerGone = writers.get(key) ?? isPreparedLaunchIncarnationGone(writer)
    writers.set(key, writerGone)
    if ((await writerGone) && (await readerGone(path))) {
      await rm(path, { recursive: true, force: true })
    }
  }
}

async function readerGone(path: string): Promise<boolean> {
  let recorded: string
  try {
    recorded = await readFile(join(path, OWNED_STAGING_READER_FILE), 'utf8')
  } catch (error) {
    // The writer names the reader before handing over the path, so no file means no reader.
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
  const pid = Number(recorded)
  return Number.isSafeInteger(pid) && pid > 0 && inspectProcessSignal(pid) === 'missing'
}

function parseWriter(text: string) {
  try {
    return parsePreparedLaunchIncarnation(JSON.parse(text))
  } catch {
    return null
  }
}
