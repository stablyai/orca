import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { cloneMacTree } from '../macos-tree-clone'
import { rm } from '../asar-transparent-fs'
import { ensurePrivateDir } from './daemon-private-file-modes'
import { inspectMacProcessCodeIdentity } from './daemon-mac-code-identity'

/** Plain Node helper packaged by config/scripts/macos-terminal-host-bundle.cjs. */
export const MAC_TERMINAL_HOST_BUNDLE = 'Orca Terminal Host.app'
export const MAC_TERMINAL_HOST_EXECUTABLE = 'orca-terminal-host'
export const MAC_DAEMON_COPY_PREFIX = 'terminal-host-'

export type MacDaemonBundle = {
  directory: string
  execPath: string
  entryPath: string
}

/** Keep signed copies outside paths replaced by the updater. */
export function getMacDaemonBundleRoot(userDataPath: string): string {
  return join(userDataPath, 'daemon-host', 'macos')
}

/** .noindex suppresses Spotlight indexing; direct execution can still register with LaunchServices. */
export function macDaemonCopyBundlePath(directory: string): string {
  return join(directory, 'app.noindex', MAC_TERMINAL_HOST_BUNDLE)
}

function describeCopy(directory: string): MacDaemonBundle {
  const contents = join(macDaemonCopyBundlePath(directory), 'Contents')
  return {
    directory,
    execPath: join(contents, 'MacOS', MAC_TERMINAL_HOST_EXECUTABLE),
    entryPath: join(contents, 'Resources', 'daemon', 'out', 'main', 'daemon-entry.js')
  }
}

function appBundleForMainExecutable(executable: string): string {
  const bundle = resolve(dirname(executable), '..', '..')
  if (
    !isAbsolute(executable) ||
    !bundle.endsWith('.app') ||
    dirname(executable) !== join(bundle, 'Contents', 'MacOS')
  ) {
    throw new Error('The running macOS process is not an app bundle executable')
  }
  return bundle
}

// codesign display fields normally arrive on stderr.
async function readCodesignField(
  args: string[],
  prefix: string,
  signal: AbortSignal
): Promise<string> {
  const result = await runProcess({
    program: '/usr/bin/codesign',
    args,
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    signal
  })
  const line = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(prefix))
  if (result.code !== 0 || result.timedOut || result.outputTruncated || !line) {
    throw new Error(`Could not read ${prefix.trim()} from codesign`)
  }
  return line.slice(prefix.length)
}

export async function materializeMacDaemonBundle(
  root: string,
  signal: AbortSignal
): Promise<MacDaemonBundle> {
  // After an update, process.execPath may name the new bundle instead of the running one.
  const running = await inspectMacProcessCodeIdentity(process.pid)
  if (!running.executablePath) {
    throw new Error('Could not resolve the running macOS app bundle')
  }
  const appBundle = await realpath(appBundleForMainExecutable(running.executablePath))
  const source = join(appBundle, 'Contents', 'Helpers', MAC_TERMINAL_HOST_BUNDLE)
  const cdhash = await readCodesignField(['-dvvv', source], 'CDHash=', signal)
  if (!/^[0-9a-f]{40,64}$/.test(cdhash)) {
    throw new Error('The macOS terminal host has an unexpected CDHash')
  }
  const name = `${MAC_DAEMON_COPY_PREFIX}${cdhash}`
  const copy = describeCopy(join(root, name))
  // Only verified copies are published, so later launches can reuse them without re-verification.
  if (existsSync(copy.directory)) {
    return copy
  }
  ensurePrivateDir(root)
  // The PID keeps our collector from deleting an in-progress staging copy.
  const staging = await mkdtemp(join(root, `${name}.staging-${process.pid}-`))
  try {
    const stagedBundle = macDaemonCopyBundlePath(staging)
    await mkdir(dirname(stagedBundle))
    await cloneMacTree(source, stagedBundle, signal)
    // Matching the running app’s designated requirement preserves its privacy grants.
    const requirement = await readCodesignField(
      ['--display', '-r-', appBundle],
      'designated => ',
      signal
    )
    const verified = await runProcess({
      program: '/usr/bin/codesign',
      args: ['--verify', '--strict', '-R', `=${requirement}`, stagedBundle],
      maxOutputBytes: 8192,
      signal
    })
    if (verified.code !== 0 || verified.timedOut) {
      throw new Error("The macOS terminal host copy does not satisfy the app's signature")
    }
    await rename(staging, copy.directory).catch((error: unknown) => {
      // A competing publisher verified the same helper before publishing.
      if (!existsSync(copy.directory)) {
        throw error
      }
    })
    return copy
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}
