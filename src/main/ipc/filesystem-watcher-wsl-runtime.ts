import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  createWslRuntimeCancellationError,
  installWslWatcherRuntime,
  WslWatcherCompatibilityError,
  type InstalledWslWatcherRuntime,
  type WslWatcherManifest
} from './filesystem-watcher-wsl-runtime-installer'

export {
  createWslRuntimeTransferPaths,
  INSTALL_SCRIPT,
  parseInstallerResponse,
  PROBE_BUNDLE_SENTINEL,
  WslWatcherCompatibilityError
} from './filesystem-watcher-wsl-runtime-installer'
export type { InstalledWslWatcherRuntime } from './filesystem-watcher-wsl-runtime-installer'

type BundlePathOptions = {
  cwd?: string
  moduleDir?: string
  packaged?: boolean
  resourcesPath?: string
}

const execFileAsync = promisify(execFile)
type RuntimeInstallation = {
  abortController: AbortController
  owners: Set<symbol>
  promise: Promise<InstalledWslWatcherRuntime>
  settled: boolean
}

const installations = new Map<string, RuntimeInstallation>()
const runningQueries = new Map<string, Promise<boolean>>()

function resolveDevelopmentBundlePointer(cwd: string): string | null {
  const pointerPath = resolve(cwd, 'out', 'wsl-watcher.current.json')
  if (!existsSync(pointerPath)) {
    return null
  }
  let pointer: { protocol?: unknown; bundleVersion?: unknown; relativePath?: unknown }
  try {
    pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
  } catch {
    throw new WslWatcherCompatibilityError(`Invalid managed WSL watcher pointer at ${pointerPath}`)
  }
  const version = pointer.bundleVersion
  const expectedRelativePath = typeof version === 'string' ? `wsl-watcher.builds/${version}` : null
  if (
    pointer.protocol !== 1 ||
    typeof version !== 'string' ||
    !/^[a-f0-9]{20}$/.test(version) ||
    !expectedRelativePath ||
    pointer.relativePath !== expectedRelativePath
  ) {
    throw new WslWatcherCompatibilityError(`Invalid managed WSL watcher pointer at ${pointerPath}`)
  }
  const sourcePath = resolve(dirname(pointerPath), ...expectedRelativePath.split('/'))
  if (!existsSync(sourcePath)) {
    throw new WslWatcherCompatibilityError(
      `Missing immutable managed WSL watcher source at ${sourcePath}`
    )
  }
  return sourcePath
}

export function resolveWslWatcherBundlePath(options: BundlePathOptions = {}): string {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  const moduleDir = options.moduleDir ?? __dirname
  const packaged =
    options.packaged ??
    Boolean(
      (resourcesPath && existsSync(join(resourcesPath, 'app.asar'))) ||
      moduleDir.includes('app.asar')
    )
  const packagedPath = resourcesPath ? join(resourcesPath, 'wsl-watcher') : ''
  if (packaged) {
    if (packagedPath && existsSync(packagedPath)) {
      return packagedPath
    }
    throw new WslWatcherCompatibilityError(
      `Missing packaged WSL watcher resource at ${packagedPath}`
    )
  }
  const cwd = options.cwd ?? process.cwd()
  const pointedSource = resolveDevelopmentBundlePointer(cwd)
  if (pointedSource) {
    return pointedSource
  }
  const fromCwd = resolve(cwd, 'out', 'wsl-watcher')
  if (existsSync(fromCwd)) {
    return fromCwd
  }
  return resolve(moduleDir, '..', 'wsl-watcher')
}

function validateManifest(value: unknown): WslWatcherManifest {
  const manifest = value as Partial<WslWatcherManifest>
  if (
    manifest?.protocol !== 1 ||
    manifest.installLayout !== 1 ||
    typeof manifest.nodeVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(manifest.nodeVersion) ||
    typeof manifest.bundleVersion !== 'string' ||
    !/^[a-f0-9]{20}$/.test(manifest.bundleVersion)
  ) {
    throw new WslWatcherCompatibilityError('Invalid managed WSL watcher manifest')
  }
  return manifest as WslWatcherManifest
}

export async function readWslWatcherBundleManifest(
  bundlePath: string
): Promise<WslWatcherManifest> {
  try {
    return validateManifest(JSON.parse(await readFile(join(bundlePath, 'manifest.json'), 'utf8')))
  } catch (error) {
    if (error instanceof WslWatcherCompatibilityError) {
      throw error
    }
    // Why: a missing or corrupt bundle cannot heal at runtime; classifying it
    // permanent stops the native reprobe loop from retrying every 30s forever.
    throw new WslWatcherCompatibilityError(
      `Unreadable managed WSL watcher bundle at ${bundlePath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function installRuntime(
  distro: string,
  signal?: AbortSignal
): Promise<InstalledWslWatcherRuntime> {
  const bundlePath = resolveWslWatcherBundlePath()
  const manifest = await readWslWatcherBundleManifest(bundlePath)
  return installWslWatcherRuntime(distro, bundlePath, manifest, signal)
}

function createInstallation(distro: string): RuntimeInstallation {
  const abortController = new AbortController()
  const installation: RuntimeInstallation = {
    abortController,
    owners: new Set(),
    promise: Promise.resolve(null as never),
    settled: false
  }
  installation.promise = installRuntime(distro, abortController.signal)
  const release = (): void => {
    installation.settled = true
    if (installations.get(distro) === installation) {
      installations.delete(distro)
    }
  }
  void installation.promise.then(release, release)
  installations.set(distro, installation)
  return installation
}

function attachInstallationOwner(
  installation: RuntimeInstallation,
  signal?: AbortSignal
): Promise<InstalledWslWatcherRuntime> {
  const owner = Symbol('runtime-installation-owner')
  installation.owners.add(owner)
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const release = (): void => {
      if (settled) {
        return
      }
      settled = true
      signal?.removeEventListener('abort', onAbort)
      installation.owners.delete(owner)
      if (!installation.settled && installation.owners.size === 0) {
        // Why: installation work is shared per distro; one cancelled watcher
        // must not stop the process while another watcher still owns it.
        installation.abortController.abort()
      }
    }
    const onAbort = (): void => {
      release()
      rejectPromise(createWslRuntimeCancellationError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    void installation.promise.then(
      (runtime) => {
        if (!settled) {
          release()
          resolvePromise(runtime)
        }
      },
      (error: unknown) => {
        if (!settled) {
          release()
          rejectPromise(error)
        }
      }
    )
  })
}

export function ensureWslWatcherRuntime(
  distro: string,
  signal?: AbortSignal
): Promise<InstalledWslWatcherRuntime> {
  if (signal?.aborted) {
    return Promise.reject(createWslRuntimeCancellationError())
  }
  let installation = installations.get(distro)
  if (installation?.abortController.signal.aborted) {
    installations.delete(distro)
    installation = undefined
  }
  installation ??= createInstallation(distro)
  return attachInstallationOwner(installation, signal)
}

export function decodeWslListOutput(output: string | Buffer): string {
  return typeof output === 'string'
    ? output
    : output.toString(output.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '')
}

export function parseRunningWslDistros(output: string | Buffer): string[] {
  return decodeWslListOutput(output)
    .replaceAll('\0', '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter(Boolean)
}

async function queryWslDistroRunning(distro: string): Promise<boolean> {
  try {
    // Why: wsl.exe emits UTF-16LE; a raw buffer lets decodeWslListOutput pick
    // the encoding so non-ASCII distro names survive instead of garbling.
    const { stdout } = await execFileAsync('wsl.exe', ['--list', '--running', '--quiet'], {
      encoding: 'buffer',
      timeout: 5_000,
      maxBuffer: 64 * 1024
    })
    return parseRunningWslDistros(stdout).some(
      (runningDistro) => runningDistro.toLowerCase() === distro.toLowerCase()
    )
  } catch {
    return false
  }
}

export function isWslDistroRunning(distro: string): Promise<boolean> {
  let pending = runningQueries.get(distro)
  if (!pending) {
    pending = queryWslDistroRunning(distro).finally(() => runningQueries.delete(distro))
    runningQueries.set(distro, pending)
  }
  return pending
}

export function resetWslWatcherRuntimeForTest(): void {
  for (const installation of installations.values()) {
    installation.abortController.abort()
  }
  installations.clear()
  runningQueries.clear()
}
