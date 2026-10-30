import { access, mkdir, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import {
  setRuntimeBrowserUnavailableCause,
  type RuntimeBrowserCommandsFactory,
  type RuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import type { ExternalChromiumLaunch } from './external-chromium-browser-session'
import { resolveOrcadAgentBrowserBinary } from './orcad-agent-browser-binary'
import { ElectronServeBrowserProcess } from './electron-serve-browser-process'
import { openOrcadBrowserInstallPark } from './orcad-browser-install-park'
import { errorMessage } from '../../shared/error-message'

export type OrcadBrowserProvider = {
  kind: 'electron' | 'chromium'
  factory: RuntimeBrowserCommandsFactory
  isAvailable(): boolean
  supportsGoogleCookieClear?(): boolean
  stop(): Promise<void>
}

export type OrcadBrowserProviderOptions = {
  userDataPath: string
  signal?: AbortSignal
  environment?: NodeJS.ProcessEnv
  resolveInstalledElectronExecutable?: () => Promise<string | null>
  resolveAgentBrowserBinary?: () => string | null
}

type ExecutableProbe = 'ok' | 'missing' | 'not_executable'

class OrcadBrowserCleanupError extends AggregateError {}

async function cleanupFailedProvider(
  processHandle: { stop(): Promise<void> },
  startupError: unknown
): Promise<never> {
  try {
    await processHandle.stop()
  } catch (cleanupError) {
    throw new OrcadBrowserCleanupError([startupError, cleanupError], 'orcad_browser_cleanup_failed')
  }
  throw startupError
}

async function probeExecutable(path: string): Promise<ExecutableProbe> {
  const mode = process.platform === 'win32' ? constants.F_OK : constants.X_OK
  try {
    await access(path, mode)
    return 'ok'
  } catch {
    if (mode === constants.F_OK) {
      return 'missing'
    }
  }
  try {
    await access(path, constants.F_OK)
    return 'not_executable'
  } catch {
    return 'missing'
  }
}

async function executableExists(path: string): Promise<boolean> {
  return (await probeExecutable(path)) === 'ok'
}

export function installedElectronCandidates(
  platform: NodeJS.Platform,
  homePath: string,
  environment: NodeJS.ProcessEnv
): string[] {
  const joinPath = platform === 'win32' ? win32.join : posix.join
  if (platform === 'darwin') {
    return [
      '/Applications/Orca.app/Contents/MacOS/Orca',
      joinPath(homePath, 'Applications', 'Orca.app', 'Contents', 'MacOS', 'Orca')
    ]
  }
  if (platform === 'win32') {
    return [
      ...(environment.LOCALAPPDATA
        ? [joinPath(environment.LOCALAPPDATA, 'Programs', 'Orca', 'Orca.exe')]
        : []),
      ...(environment.ProgramFiles ? [joinPath(environment.ProgramFiles, 'Orca', 'Orca.exe')] : [])
    ]
  }
  return [
    joinPath(homePath, '.local', 'bin', 'orca-ide'),
    '/usr/local/bin/orca-ide',
    '/usr/bin/orca-ide',
    '/opt/Orca/orca-ide'
  ]
}

async function isScriptShim(path: string): Promise<boolean> {
  try {
    const handle = await open(await realpath(path), 'r')
    try {
      const head = Buffer.alloc(2)
      const { bytesRead } = await handle.read(head, 0, 2, 0)
      return bytesRead === 2 && head[0] === 0x23 && head[1] === 0x21
    } finally {
      await handle.close()
    }
  } catch {
    return true
  }
}

/** Require installer-owned paths; arbitrary AppImage locations cannot establish ownership. */
export async function resolveInstalledElectronExecutable(
  candidates: string[] = installedElectronCandidates(process.platform, homedir(), process.env)
): Promise<string | null> {
  for (const candidate of candidates) {
    if ((await executableExists(candidate)) && !(await isScriptShim(candidate))) {
      return candidate
    }
  }
  return null
}

async function startProvider(
  agentBrowserPath: string,
  launch: ExternalChromiumLaunch,
  userDataPath: string,
  signal?: AbortSignal
): Promise<OrcadBrowserProvider> {
  const processHandle = new ExternalChromiumBrowserProcess(agentBrowserPath, launch, userDataPath)
  try {
    await processHandle.start(signal)
  } catch (error) {
    return cleanupFailedProvider(processHandle, error)
  }
  return {
    kind: launch.provider,
    factory: (host) => processHandle.createCommands(host),
    isAvailable: () => processHandle.isAvailable(),
    stop: () => processHandle.stop()
  }
}

async function startElectronServeProvider(
  executablePath: string,
  signal?: AbortSignal
): Promise<OrcadBrowserProvider> {
  const processHandle = new ElectronServeBrowserProcess(executablePath)
  try {
    await processHandle.start(signal)
  } catch (error) {
    return cleanupFailedProvider(processHandle, error)
  }
  const installPark = openOrcadBrowserInstallPark(executablePath, {
    pid: () => processHandle.pid(),
    stop: () => processHandle.stop(),
    start: async (restartSignal) => {
      try {
        await processHandle.start(restartSignal)
      } catch (error) {
        await processHandle.stop()
        throw error
      }
    }
  })
  return {
    kind: 'electron',
    supportsGoogleCookieClear: () => processHandle.supportsGoogleCookieClear(),
    factory: (host) => processHandle.createCommands(host),
    isAvailable: () => processHandle.isAvailable(),
    stop: async () => {
      await installPark?.close()
      await processHandle.stop()
    }
  }
}

export async function resolveOrcadBrowserProvider(
  options: OrcadBrowserProviderOptions
): Promise<OrcadBrowserProvider | null> {
  const environment = options.environment ?? process.env
  if (options.signal?.aborted) {
    return null
  }
  await mkdir(options.userDataPath, { recursive: true, mode: 0o700 })

  const declined = (cause: RuntimeBrowserUnavailableCause): null => {
    setRuntimeBrowserUnavailableCause(cause)
    return null
  }

  const installedElectronExecutable = await (
    options.resolveInstalledElectronExecutable ?? resolveInstalledElectronExecutable
  )()
  if (options.signal?.aborted) {
    return null
  }
  // Defer Electron failure: configured Chromium may succeed or provide a more actionable cause.
  let electronFailure: RuntimeBrowserUnavailableCause | null = null
  if (installedElectronExecutable) {
    try {
      setRuntimeBrowserUnavailableCause(null)
      return await startElectronServeProvider(installedElectronExecutable, options.signal)
    } catch (error) {
      if (error instanceof OrcadBrowserCleanupError) {
        throw error
      }
      if (options.signal?.aborted) {
        return null
      }
      console.warn('[orcad] Installed Electron browser provider unavailable:', error)
      electronFailure = { reason: 'electron_start_failed', detail: errorMessage(error) }
    }
  }

  // Read configuration before probing drivers so missing drivers cannot look like missing configuration.
  const chromiumExecutable = environment.ORCA_BROWSER_EXECUTABLE?.trim()
  if (!chromiumExecutable) {
    return declined(electronFailure ?? { reason: 'unconfigured' })
  }

  const agentBrowserPath = (options.resolveAgentBrowserBinary ?? resolveOrcadAgentBrowserBinary)()
  if (!agentBrowserPath) {
    return declined({ reason: 'driver_missing' })
  }

  const probe = await probeExecutable(chromiumExecutable)
  if (options.signal?.aborted) {
    return null
  }
  if (probe !== 'ok') {
    return declined({
      reason: probe === 'missing' ? 'executable_not_found' : 'executable_not_executable',
      detail: chromiumExecutable
    })
  }

  try {
    setRuntimeBrowserUnavailableCause(null)
    return await startProvider(
      agentBrowserPath,
      { executablePath: chromiumExecutable, provider: 'chromium' },
      options.userDataPath,
      options.signal
    )
  } catch (error) {
    if (error instanceof OrcadBrowserCleanupError) {
      throw error
    }
    if (options.signal?.aborted) {
      return null
    }
    console.warn('[orcad] External Chromium browser provider unavailable:', error)
    return declined({ reason: 'chromium_start_failed', detail: errorMessage(error) })
  }
}
