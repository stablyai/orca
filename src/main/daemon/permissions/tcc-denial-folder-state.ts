// Folder-class root state read before the app's own opendir can materialize or change it.

import { realpath } from 'node:fs/promises'
import type { runProcess } from '@orca/process-host'
import type { MacTccFolderClass } from '../../../shared/daemon-adoption-telemetry'
import type {
  FolderFlag,
  IcloudManaged,
  VolumeType
} from '../../../shared/daemon-tcc-denial-capture'

const PROBE_TIMEOUT_MS = 1_500
// sys/stat.h SF_DATALESS: the entry's contents live in a file provider, not on disk.
const SF_DATALESS = 0x40000000
const KNOWN_VOLUME_TYPES: readonly VolumeType[] = [
  'apfs',
  'hfs',
  'smbfs',
  'nfs',
  'afpfs',
  'webdav',
  'msdos',
  'exfat'
]
// Finder's switches for iCloud "Desktop & Documents Folders".
const ICLOUD_FINDER_KEY: Partial<Record<MacTccFolderClass, string>> = {
  desktop: 'FXICloudDriveDesktop',
  documents: 'FXICloudDriveDocuments'
}

export type TccFolderState = {
  dataless: FolderFlag
  icloud: IcloudManaged
  volumeType: VolumeType
}

type ProbeOutput = { code: number | null; timedOut: boolean; stdout: string; stderr: string }

export function classifyStatFlags(output: ProbeOutput | null): FolderFlag {
  if (!output || output.timedOut || output.code !== 0) {
    return 'unknown'
  }
  const flags = Number.parseInt(output.stdout.trim(), 16)
  if (!Number.isFinite(flags)) {
    return 'unknown'
  }
  return (flags & SF_DATALESS) !== 0 ? 'yes' : 'no'
}

export function classifyIcloudSetting(output: ProbeOutput | null): IcloudManaged {
  if (!output || output.timedOut) {
    return 'unknown'
  }
  if (output.code === 0) {
    const value = output.stdout.trim()
    return value === '1' ? 'yes' : value === '0' ? 'no' : 'unknown'
  }
  // A key that was never written means the user never turned the sync on.
  return /does not exist/.test(output.stderr) ? 'no' : 'unknown'
}

/** Volume type of the longest mount point containing `path`, from `/sbin/mount` output. */
export function classifyVolumeType(output: ProbeOutput | null, path: string): VolumeType {
  if (!output || output.timedOut || output.code !== 0) {
    return 'unknown'
  }
  let best: { mountPoint: string; type: string } | null = null
  for (const line of output.stdout.split('\n')) {
    const match = / on (.+) \(([^,)]+)/.exec(line)
    if (!match) {
      continue
    }
    const [, mountPoint, type] = match
    const contains = mountPoint === '/' || path === mountPoint || path.startsWith(`${mountPoint}/`)
    if (contains && (!best || mountPoint.length > best.mountPoint.length)) {
      best = { mountPoint, type }
    }
  }
  if (!best) {
    return 'unknown'
  }
  return KNOWN_VOLUME_TYPES.find((type) => type === best.type) ?? 'other'
}

async function probe(
  program: string,
  args: string[],
  run: typeof runProcess
): Promise<ProbeOutput | null> {
  try {
    return await run({
      program,
      args,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      killOnOutputLimit: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    return null
  }
}

/** A root relocated to a hung volume must not hold the denial notice behind it. */
async function resolveWithin(path: string, timeoutMs: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(path), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([realpath(path).catch(() => path), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Metadata of the class root only: none of these read the protected folder's contents. */
export async function readTccFolderState(
  classRoot: string,
  cwdClass: MacTccFolderClass,
  run: typeof runProcess
): Promise<TccFolderState> {
  // A relocated class root (symlink to another volume) is what decides the volume.
  const resolved = await resolveWithin(classRoot, PROBE_TIMEOUT_MS)
  const icloudKey = ICLOUD_FINDER_KEY[cwdClass]
  const [flags, icloud, mounts] = await Promise.all([
    probe('/usr/bin/stat', ['-f', '%Xf', resolved], run),
    icloudKey ? probe('/usr/bin/defaults', ['read', 'com.apple.finder', icloudKey], run) : null,
    probe('/sbin/mount', [], run)
  ])
  return {
    dataless: classifyStatFlags(flags),
    icloud: icloudKey ? classifyIcloudSetting(icloud) : 'not_applicable',
    volumeType: classifyVolumeType(mounts, resolved)
  }
}
