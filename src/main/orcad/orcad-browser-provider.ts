import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import {
  setRuntimeBrowserUnavailableCause,
  type RuntimeBrowserCommandsFactory,
  type RuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import {
  ExternalChromiumBrowserProcess,
  type ExternalChromiumLaunch
} from './external-chromium-browser-process'
import { resolveOrcadAgentBrowserBinary } from './orcad-agent-browser-binary'
import { ElectronServeBrowserProcess } from './electron-serve-browser-process'

export type OrcadBrowserProvider = {
  kind: 'electron' | 'chromium'
  factory: RuntimeBrowserCommandsFactory
  isAvailable(): boolean
  stop(): Promise<void>
}

export type OrcadBrowserProviderOptions = {
  userDataPath: string
  environment?: NodeJS.ProcessEnv
  resolveInstalledElectronExecutable?: () => Promise<string | null>
  resolveAgentBrowserBinary?: () => string | null
}

type ExecutableProbe = 'ok' | 'missing' | 'not_executable'

/** Splits the two failures apart: a wrong path and a forgotten chmod +x need different fixes. */
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

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** Only paths with stable installer ownership qualify; never guess arbitrary AppImage locations. */
export async function resolveInstalledElectronExecutable(): Promise<string | null> {
  const candidates = installedElectronCandidates(process.platform, homedir(), process.env)
  for (const candidate of candidates) {
    if (await executableExists(candidate)) {
      return candidate
    }
  }
  return null
}

async function startProvider(
  agentBrowserPath: string,
  launch: ExternalChromiumLaunch,
  userDataPath: string
): Promise<OrcadBrowserProvider> {
  const processHandle = new ExternalChromiumBrowserProcess(agentBrowserPath, launch, userDataPath)
  try {
    await processHandle.start()
  } catch (error) {
    await processHandle.stop()
    throw error
  }
  return {
    kind: launch.provider,
    factory: (host) => processHandle.createCommands(host),
    isAvailable: () => processHandle.isAvailable(),
    stop: () => processHandle.stop()
  }
}

async function startElectronServeProvider(executablePath: string): Promise<OrcadBrowserProvider> {
  const processHandle = new ElectronServeBrowserProcess(executablePath)
  try {
    await processHandle.start()
  } catch (error) {
    await processHandle.stop()
    throw error
  }
  return {
    kind: 'electron',
    factory: (host) => processHandle.createCommands(host),
    isAvailable: () => processHandle.isAvailable(),
    stop: () => processHandle.stop()
  }
}

/** Resolve once at startup: Electron first, then the operator-supplied Chromium. */
export async function resolveOrcadBrowserProvider(
  options: OrcadBrowserProviderOptions
): Promise<OrcadBrowserProvider | null> {
  const environment = options.environment ?? process.env
  await mkdir(options.userDataPath, { recursive: true, mode: 0o700 })

  const declined = (cause: RuntimeBrowserUnavailableCause): null => {
    setRuntimeBrowserUnavailableCause(cause)
    return null
  }

  const installedElectronExecutable = await (
    options.resolveInstalledElectronExecutable ?? resolveInstalledElectronExecutable
  )()
  // Why held rather than reported now: Chromium may still resolve, and if it does not, its
  // own concrete fault is the more actionable one for an operator who set the env var.
  let electronFailure: RuntimeBrowserUnavailableCause | null = null
  if (installedElectronExecutable) {
    try {
      setRuntimeBrowserUnavailableCause(null)
      return await startElectronServeProvider(installedElectronExecutable)
    } catch (error) {
      console.warn('[orcad] Installed Electron browser provider unavailable:', error)
      electronFailure = { reason: 'electron_start_failed', detail: errorDetail(error) }
    }
  }

  // Why the env var is read before the driver: with it set, a missing driver is a driver
  // problem, not an unconfigured host. Telling someone to set ORCA_BROWSER_EXECUTABLE when
  // they already did is the misdirection this ordering exists to prevent.
  const chromiumExecutable = environment.ORCA_BROWSER_EXECUTABLE?.trim()
  if (!chromiumExecutable) {
    return declined(electronFailure ?? { reason: 'unconfigured' })
  }

  const agentBrowserPath = (options.resolveAgentBrowserBinary ?? resolveOrcadAgentBrowserBinary)()
  if (!agentBrowserPath) {
    return declined({ reason: 'driver_missing' })
  }

  const probe = await probeExecutable(chromiumExecutable)
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
      options.userDataPath
    )
  } catch (error) {
    console.warn('[orcad] External Chromium browser provider unavailable:', error)
    return declined({ reason: 'chromium_start_failed', detail: errorDetail(error) })
  }
}
