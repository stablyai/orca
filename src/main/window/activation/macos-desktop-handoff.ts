import { app } from 'electron'
import { dirname, resolve } from 'node:path'
import { isSameUserDataPathAsync } from '../../../shared/remote-runtime/serve-supervisor/serve-user-data-path'
import { macCoordinationRoot } from '../../../shared/remote-runtime/serve-supervisor/serve-bundle-coordination'
import { spawnProcess } from '@orca/process-host'
import { applyBackgroundActivationPolicy } from './foreground-activation-policy'

export async function shouldHandOffServeDesktopActivation(options: {
  isServeMode: boolean
  isPackaged: boolean
  userDataPath: string
  platform?: NodeJS.Platform
}): Promise<boolean> {
  return (
    (options.platform ?? process.platform) === 'darwin' &&
    options.isPackaged &&
    options.isServeMode &&
    !(await isSameUserDataPathAsync(
      options.userDataPath,
      macCoordinationRoot(app.getPath('home')),
      'darwin'
    ))
  )
}

/** LaunchServices can route desktop opens to a background bundle instance; hand them to the desktop profile. */
export function handOffToDesktopApp(
  args: readonly string[],
  options: {
    platform?: NodeJS.Platform
    executablePath?: string
    reapplyActivationPolicy?: () => void
    env?: Readonly<Record<string, string | undefined>>
    userRequested?: true
  } = {}
): void {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return
  }
  // Only an explicit OS open can override a production host’s background launch; E2E remains isolated.
  if (!isAutomatedLaunch(options.env ?? process.env, options.userRequested === true)) {
    launchDesktopInstance(args, options.executablePath, macCoordinationRoot(app.getPath('home')))
  }
  // Handling an open can promote the background host into the Dock.
  if (options.reapplyActivationPolicy) {
    options.reapplyActivationPolicy()
  } else {
    applyBackgroundActivationPolicy({ serveWithoutDesktopWindow: true, warn: console.warn })
  }
}

function launchDesktopInstance(
  args: readonly string[],
  executablePath: string | undefined,
  userDataPath: string
): void {
  const bundlePath = resolve(dirname(executablePath ?? app.getPath('exe')), '..', '..')
  const child = spawnProcess({
    program: '/usr/bin/open',
    args: ['-n', bundlePath, '--args', `--user-data-dir=${userDataPath}`, ...args],
    // open inherits this environment into the app; empty matches a Dock launch.
    env: {},
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', (error) => {
    console.warn('[window] Failed to hand activation to the desktop app', error)
  })
  child.unref()
}

function isAutomatedLaunch(
  env: Readonly<Record<string, string | undefined>>,
  userRequested: boolean
): boolean {
  return (
    (env.ORCA_BACKGROUND_LAUNCH === '1' && !userRequested) ||
    Object.keys(env).some((key) => key.startsWith('ORCA_E2E_') && Boolean(env[key]))
  )
}

type DesktopHandoffRequest = { userRequested?: true }

/** Batch AppKit open-file events into one desktop launch. */
export function createDesktopHandoff(options: {
  drainArguments: () => string[]
  handOff?: (args: readonly string[], request: DesktopHandoffRequest) => void
}): (request?: DesktopHandoffRequest) => void {
  const handOff = options.handOff ?? handOffToDesktopApp
  let scheduled = false
  let userRequested = false
  return (request = {}) => {
    userRequested ||= request.userRequested === true
    if (scheduled) {
      return
    }
    scheduled = true
    setImmediate(() => {
      scheduled = false
      const request: DesktopHandoffRequest = userRequested ? { userRequested: true } : {}
      userRequested = false
      handOff(options.drainArguments(), request)
    })
  }
}

/** Drains the background host’s buffered open into the desktop app’s launch arguments. */
export function desktopHandoffArguments(pending: {
  deepLinks: { drainArguments: () => string[] }
  pluginInstallLinks: { consume: () => string | null }
  osOpenedDocuments: { consume: () => string[] }
}): string[] {
  const pluginLink = pending.pluginInstallLinks.consume()
  return [
    ...pending.deepLinks.drainArguments(),
    ...(pluginLink ? [pluginLink] : []),
    ...pending.osOpenedDocuments.consume()
  ]
}
