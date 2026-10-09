import { mkdir, mkdtemp, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { rm } from '../asar-transparent-fs'
import { ensurePrivateDir } from './daemon-private-file-modes'
import { inspectMacProcessCodeIdentity } from './daemon-mac-code-identity'
import { MAC_DAEMON_BUNDLE_FOLDER, writeMacDaemonJobRecord } from './macos-daemon-bundle-retirement'

/** Packaged by config/scripts/macos-terminal-host-bundle.cjs; its main executable is plain Node. */
export const MAC_TERMINAL_HOST_BUNDLE = 'Orca Terminal Host.app'
export const MAC_TERMINAL_HOST_EXECUTABLE = 'orca-terminal-host'

export type MacDaemonBundle = {
  directory: string
  bundlePath: string
  execPath: string
  entryPath: string
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

async function codesignRequirement(bundlePath: string, signal: AbortSignal): Promise<string> {
  const result = await runProcess({
    program: '/usr/bin/codesign',
    args: ['--display', '-r-', bundlePath],
    timeoutMs: 5_000,
    maxOutputBytes: 8192,
    signal
  })
  const requirement = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .find((line) => line.startsWith('designated => '))
  if (result.code !== 0 || result.timedOut || result.outputTruncated || !requirement) {
    throw new Error('Could not read the macOS app signing requirement')
  }
  return requirement
}

/** Private signed runtime copies; telemetry classifies a daemon spawned from here as `stable-copy`. */
export function getMacDaemonBundleRoot(userDataPath: string): string {
  return join(userDataPath, 'daemon-host', 'macos')
}

/** Keep signed bytes and their bundle layout outside the updater's rename/delete window. */
export async function materializeMacDaemonBundle(
  userDataPath: string,
  label: string,
  signal: AbortSignal
): Promise<MacDaemonBundle> {
  const running = await inspectMacProcessCodeIdentity(process.pid)
  if (!running.executablePath) {
    throw new Error('Could not resolve the running macOS app bundle')
  }
  const runningBundle = await realpath(appBundleForMainExecutable(running.executablePath))
  // Copying only the helper keeps each retained runtime ~124 MiB instead of the whole app.
  const sourceBundle = join(runningBundle, 'Contents', 'Helpers', MAC_TERMINAL_HOST_BUNDLE)
  if (!(await stat(sourceBundle).catch(() => null))?.isDirectory()) {
    throw new Error('The running app has no macOS terminal host helper')
  }
  // The helper must carry the running app's designated requirement to inherit Orca's grants.
  const requirement = await codesignRequirement(runningBundle, signal)
  const root = getMacDaemonBundleRoot(userDataPath)
  ensurePrivateDir(root)
  const directory = await mkdtemp(join(root, 'runtime-'))
  const bundlePath = join(directory, MAC_DAEMON_BUNDLE_FOLDER, basename(sourceBundle))
  try {
    // Recorded before copying so a crash mid-copy leaves a copy retirement can still claim.
    await writeMacDaemonJobRecord(directory, label, false)
    await mkdir(dirname(bundlePath))
    const copy = async (clone: boolean): Promise<boolean> => {
      const result = await runProcess({
        program: '/bin/cp',
        args: [clone ? '-cR' : '-R', sourceBundle, bundlePath],
        timeoutMs: 45_000,
        maxOutputBytes: 8192,
        signal
      })
      return result.code === 0 && !result.timedOut
    }
    if (!(await copy(true))) {
      // A failed APFS clone can leave a partial tree on other filesystems.
      await rm(bundlePath, { recursive: true, force: true })
      if (!(await copy(false))) {
        throw new Error('Could not copy the macOS terminal runtime')
      }
    }
    const verified = await runProcess({
      program: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', bundlePath],
      timeoutMs: 45_000,
      maxOutputBytes: 8192,
      signal
    })
    if (
      verified.code !== 0 ||
      verified.timedOut ||
      (await codesignRequirement(bundlePath, signal)) !== requirement
    ) {
      throw new Error('The copied macOS terminal runtime did not preserve the app signature')
    }
    return {
      directory,
      bundlePath,
      execPath: join(bundlePath, 'Contents', 'MacOS', MAC_TERMINAL_HOST_EXECUTABLE),
      entryPath: join(
        bundlePath,
        'Contents',
        'Resources',
        'daemon',
        'out',
        'main',
        'daemon-entry.js'
      )
    }
  } catch (error) {
    // No process has been launched from this private copy yet.
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
