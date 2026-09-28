import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-environment'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import { WINDOWS_CONPTY_FILES } from '../../shared/windows-conpty-release'
import {
  isRuntimeProcessTreePath,
  WINDOWS_PROCESS_TREE_REQUIRED
} from '../windows/windows-process-tree-runtime-manifest'
import { renameFileWithWindowsRetryAsync } from '../codex-accounts/fs-utils'
import { findOrcadCachePath } from '../ssh/orcad-cache-path'
import {
  acquireDaemonRuntimeLaunchPin,
  MANAGED_DAEMON_RUNTIME_DIRECTORY,
  scheduleDaemonBunRuntimePrune
} from './daemon-bun-runtime-retention'

export type DaemonBunRuntime = {
  execPath: string
  entryPath: string
  conptyLibraryPath?: string
  releaseLaunchPin?: () => void
}
type RuntimeFile = { source: string; relative: string; sha256: string }
const Manifest = z.object({
  target: z.string(),
  version: z.literal(ORCAD_BUN_VERSION),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
})

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function bundleFiles(
  root: string,
  relative = '',
  include: (relative: string) => boolean = () => true
): Promise<RuntimeFile[]> {
  const files: RuntimeFile[] = []
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name)
    if (!include(name)) {
      continue
    }
    if (entry.isDirectory()) {
      files.push(...(await bundleFiles(root, name, include)))
    } else if (entry.isFile()) {
      files.push({
        source: join(root, name),
        relative: name,
        sha256: await digest(join(root, name))
      })
    } else {
      throw new Error(`Unsupported terminal daemon artifact: ${name}`)
    }
  }
  return files.sort((a, b) => a.relative.localeCompare(b.relative))
}

export async function resolveDaemonBunRuntime(options: {
  bundleDir: string
  runtimeDir: string
  platform: NodeJS.Platform
  arch: string
  relocationRoot?: string
  windowsProcessTreeDir?: string
}): Promise<DaemonBunRuntime> {
  const filename = options.platform === 'win32' ? 'bun-runtime.exe' : 'bun-runtime'
  const runtime = join(options.runtimeDir, filename)
  const manifest = Manifest.parse(
    JSON.parse(await readFile(join(options.runtimeDir, 'runtime.json'), 'utf8'))
  )
  const target = `${options.platform}-${options.arch}${options.platform === 'linux' ? '-glibc' : ''}`
  if (manifest.target !== target || (await digest(runtime)) !== manifest.sha256) {
    throw new Error('Terminal daemon Bun runtime identity mismatch')
  }
  const files = await bundleFiles(options.bundleDir)
  if (!files.some((file) => file.relative === 'daemon-entry.js')) {
    throw new Error('Terminal daemon entry is missing')
  }
  if (options.platform === 'win32') {
    if (!options.windowsProcessTreeDir) {
      throw new Error('Windows terminal process inspection artifacts are missing')
    }
    if (!files.some((file) => file.relative === 'windows-bun-pty-gate-entry.js')) {
      throw new Error('Windows terminal gate is missing')
    }
    if (options.arch !== 'x64' && options.arch !== 'arm64') {
      throw new Error(`Unsupported Windows terminal architecture: ${options.arch}`)
    }
    const conptyFiles = await bundleFiles(join(options.runtimeDir, 'conpty'))
    for (const [filename, hash] of Object.entries(WINDOWS_CONPTY_FILES[options.arch])) {
      if (!conptyFiles.some((file) => file.relative === filename && file.sha256 === hash)) {
        throw new Error(`Windows terminal ConPTY identity mismatch: ${filename}`)
      }
    }
    for (const file of conptyFiles) {
      files.push({ ...file, relative: join('conpty', file.relative) })
    }
    const nativeFiles = await bundleFiles(options.windowsProcessTreeDir, '', (relative) =>
      isRuntimeProcessTreePath(relative.replaceAll('\\', '/'))
    )
    for (const required of WINDOWS_PROCESS_TREE_REQUIRED) {
      if (!nativeFiles.some((file) => file.relative === join(...required.split('/')))) {
        throw new Error(`Windows terminal process inspection artifact is missing: ${required}`)
      }
    }
    for (const file of nativeFiles) {
      files.push({
        ...file,
        relative: join('node_modules', '@vscode', 'windows-process-tree', file.relative)
      })
    }
  }
  if (!options.relocationRoot) {
    return {
      execPath: runtime,
      entryPath: join(options.bundleDir, 'daemon-entry.js'),
      ...(options.platform === 'win32'
        ? { conptyLibraryPath: join(options.runtimeDir, 'conpty', 'conpty.dll') }
        : {})
    }
  }
  files.push({ source: runtime, relative: filename, sha256: manifest.sha256 })
  const identity = createHash('sha256')
    .update(JSON.stringify(files.map(({ relative, sha256 }) => [relative, sha256])))
    .digest('hex')
  const verify = async (root: string): Promise<boolean> => {
    try {
      for (const file of files) {
        if ((await digest(join(root, file.relative))) !== file.sha256) {
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }
  const cached = await findOrcadCachePath(
    (attempt) =>
      join(options.relocationRoot!, `bun-${identity}${attempt ? `.repair-${attempt}` : ''}`),
    verify
  )
  if (!cached.verified) {
    const staging = join(options.relocationRoot, `.bun-staging-${randomUUID()}`)
    try {
      for (const file of files) {
        const destination = join(staging, file.relative)
        await mkdir(dirname(destination), { recursive: true })
        await copyFile(file.source, destination)
      }
      if (!(await verify(staging))) {
        throw new Error('Terminal daemon artifacts changed while copying')
      }
      try {
        await renameFileWithWindowsRetryAsync(staging, cached.path)
      } catch (error) {
        if (!(await verify(cached.path))) {
          throw error
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  return {
    execPath: join(cached.path, filename),
    entryPath: join(cached.path, 'daemon-entry.js'),
    ...(options.platform === 'win32'
      ? { conptyLibraryPath: join(cached.path, 'conpty', 'conpty.dll') }
      : {})
  }
}

export function desktopDaemonBundleDir(): string {
  const appPath = getAppEnvironment().getAppPath()
  return appPath.includes('app.asar')
    ? join(dirname(appPath), 'terminal-daemon')
    : join(appPath, 'out', 'terminal-daemon')
}

export async function resolveDesktopDaemonBunRuntime(): Promise<DaemonBunRuntime | null> {
  if (!process.versions.electron) {
    return null
  }
  const environment = getAppEnvironment()
  const appPath = environment.getAppPath()
  const packaged = appPath.includes('app.asar')
  if (process.platform === 'win32' && packaged && !process.env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is required to preserve terminal sessions across app updates')
  }
  const hostRoot =
    process.platform === 'win32' && packaged && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Orca', 'terminal-daemon-host')
      : undefined
  const managedRoot = hostRoot ? join(hostRoot, MANAGED_DAEMON_RUNTIME_DIRECTORY) : undefined
  const pin = managedRoot ? await acquireDaemonRuntimeLaunchPin(managedRoot) : undefined
  let released = false
  const releaseLaunchPin = (): void => {
    if (released) {
      return
    }
    released = true
    try {
      pin?.release()
    } catch (error) {
      console.warn('[daemon] Could not release runtime launch pin', error)
    }
    if (hostRoot) {
      scheduleDaemonBunRuntimePrune(hostRoot)
    }
  }
  try {
    const runtime = await resolveDaemonBunRuntime({
      bundleDir: desktopDaemonBundleDir(),
      runtimeDir: packaged
        ? join(dirname(appPath), 'cli-runtime')
        : join(appPath, 'out', 'cli-runtime', `${process.platform}-${process.arch}`),
      platform: process.platform,
      arch: process.arch,
      ...(process.platform === 'win32'
        ? {
            windowsProcessTreeDir: join(
              packaged ? dirname(appPath) : appPath,
              'node_modules',
              '@vscode',
              'windows-process-tree'
            )
          }
        : {}),
      ...(managedRoot ? { relocationRoot: await realpath(managedRoot) } : {})
    })
    return pin ? { ...runtime, releaseLaunchPin } : runtime
  } catch (error) {
    releaseLaunchPin()
    throw error
  }
}
