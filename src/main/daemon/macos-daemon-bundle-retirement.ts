import { opendir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { rm } from '../asar-transparent-fs'
import { inspectProcessLiveness } from './daemon-process-inspection'
import { readMacDaemonJobState, stopMacDaemonJob } from './macos-daemon-job-state'

const JOB_RECORD_NAME = 'job.json'
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
/** Spotlight skips `.noindex` folders, so the copy is never indexed or listed as an app. */
export const MAC_DAEMON_BUNDLE_FOLDER = 'app.noindex'
let collectionInFlight: Promise<void> | null = null

type MacDaemonJobRecord = {
  label: string
  producerPid: number
  submitted: boolean
}

export async function writeMacDaemonJobRecord(
  directory: string,
  label: string,
  submitted: boolean
): Promise<void> {
  const record: MacDaemonJobRecord = { label, producerPid: process.pid, submitted }
  await writeFile(join(directory, JOB_RECORD_NAME), JSON.stringify(record), {
    mode: 0o600,
    flag: submitted ? 'w' : 'wx'
  })
}

async function readJobRecord(directory: string): Promise<MacDaemonJobRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, JOB_RECORD_NAME), 'utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      !('label' in value) ||
      typeof value.label !== 'string' ||
      !/^com\.stablyai\.orca\.terminal\.[a-zA-Z0-9-]{1,80}$/.test(value.label) ||
      !('producerPid' in value) ||
      typeof value.producerPid !== 'number' ||
      !Number.isSafeInteger(value.producerPid) ||
      value.producerPid <= 0 ||
      !('submitted' in value) ||
      typeof value.submitted !== 'boolean'
    ) {
      return null
    }
    return { label: value.label, producerPid: value.producerPid, submitted: value.submitted }
  } catch {
    return null
  }
}

/** Copies made before the `.noindex` folder sit directly in the runtime directory. */
async function copiedAppBundles(directory: string): Promise<string[]> {
  const bundles: string[] = []
  for (const parent of [directory, join(directory, MAC_DAEMON_BUNDLE_FOLDER)]) {
    for (const name of await readdir(parent).catch(() => [])) {
      if (name.endsWith('.app')) {
        bundles.push(join(parent, name))
      }
    }
  }
  return bundles
}

/** All executables and mapped libraries count, including children that survived their daemon. */
export async function retireUnusedMacDaemonBundle(directory: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  try {
    const result = await runProcess({
      program: '/usr/sbin/lsof',
      args: ['-F', 'p', '+D', directory],
      timeoutMs: 5_000,
      maxOutputBytes: 8192
    })
    if (
      result.timedOut ||
      result.outputTruncated ||
      result.code !== 1 ||
      result.stdout.trim() ||
      result.stderr.trim()
    ) {
      return
    }
    // Unregistered only once unused, since macOS may resolve a running daemon's Local Network
    // grant through this record; otherwise each deleted copy leaves a stale LaunchServices entry.
    for (const bundle of await copiedAppBundles(directory)) {
      await runProcess({
        program: LSREGISTER,
        args: ['-u', bundle],
        timeoutMs: 5_000,
        maxOutputBytes: 8192
      }).catch(() => {})
    }
    await rm(directory, { recursive: true, force: true })
  } catch {
    // Unverifiable use retains code.
  }
}

async function retireIfAbandoned(directory: string, uid: number): Promise<void> {
  const record = await readJobRecord(directory)
  // A live producer may still be copying or submitting; only its exit makes the record final.
  if (
    !record ||
    (!record.submitted && inspectProcessLiveness(record.producerPid).status !== 'exited')
  ) {
    return
  }
  const service = `gui/${uid}/${record.label}`
  const state = await readMacDaemonJobState(service)
  if (state === 'stopped') {
    await stopMacDaemonJob(service)
  } else if (state !== 'missing') {
    return
  }
  await retireUnusedMacDaemonBundle(directory)
}

async function collectAbandonedBundles(root: string): Promise<void> {
  const uid = process.getuid?.()
  if (process.platform !== 'darwin' || uid === undefined) {
    return
  }
  try {
    for await (const entry of await opendir(root)) {
      if (entry.isDirectory() && entry.name.startsWith('runtime-')) {
        // Unverifiable ownership or process state retains that copy and moves on.
        await retireIfAbandoned(join(root, entry.name), uid).catch(() => {})
      }
    }
  } catch {
    // An unreadable root retains everything; collection is never a launch prerequisite.
  }
}

/** One background collection at a time, never one scan per terminal. */
export function retireAbandonedMacDaemonBundles(root: string): Promise<void> {
  collectionInFlight ??= collectAbandonedBundles(root).finally(() => {
    collectionInFlight = null
  })
  return collectionInFlight
}
