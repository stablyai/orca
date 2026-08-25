import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { RuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
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

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
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

  const installedElectronExecutable = await (
    options.resolveInstalledElectronExecutable ?? resolveInstalledElectronExecutable
  )()
  if (installedElectronExecutable) {
    try {
      return await startElectronServeProvider(installedElectronExecutable)
    } catch (error) {
      console.warn('[orcad] Installed Electron browser provider unavailable:', error)
    }
  }
  const agentBrowserPath = (options.resolveAgentBrowserBinary ?? resolveOrcadAgentBrowserBinary)()

  if (!agentBrowserPath) {
    return null
  }

  const chromiumExecutable = environment.ORCA_BROWSER_EXECUTABLE?.trim()
  if (!chromiumExecutable || !(await executableExists(chromiumExecutable))) {
    return null
  }
  try {
    return await startProvider(
      agentBrowserPath,
      { executablePath: chromiumExecutable, provider: 'chromium' },
      options.userDataPath
    )
  } catch (error) {
    console.warn('[orcad] External Chromium browser provider unavailable:', error)
    return null
  }
}
