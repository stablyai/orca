import { app } from 'electron'
import { dirname, resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { applyBackgroundActivationPolicy } from './foreground-activation-policy'

/** macOS 27 LaunchServices routes opens to the first registered bundle instance, even an SSH-started sidecar. Hand them to a fresh desktop instance instead of revealing the sidecar profile. */
export function handOffToDesktopApp(
  args: readonly string[],
  options: {
    platform?: NodeJS.Platform
    executablePath?: string
    reapplyActivationPolicy?: () => void
    env?: Readonly<Record<string, string | undefined>>
  } = {}
): void {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return
  }
  // Empty launch environments drop automation flags and would start the user's real profile; suppress that launch.
  if (!isAutomatedLaunch(options.env ?? process.env)) {
    launchDesktopInstance(args, options.executablePath)
  }
  // Handling an open promotes the sidecar into the Dock; restore its background policy afterward.
  if (options.reapplyActivationPolicy) {
    options.reapplyActivationPolicy()
  } else {
    applyBackgroundActivationPolicy({ warn: console.warn })
  }
}

function launchDesktopInstance(args: readonly string[], executablePath: string | undefined): void {
  const bundlePath = resolve(dirname(executablePath ?? app.getPath('exe')), '..', '..')
  const child = spawnProcess({
    program: '/usr/bin/open',
    args: ['-n', bundlePath, ...(args.length > 0 ? ['--args', ...args] : [])],
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

function isAutomatedLaunch(env: Readonly<Record<string, string | undefined>>): boolean {
  return (
    env.ORCA_BACKGROUND_LAUNCH === '1' ||
    Object.keys(env).some((key) => key.startsWith('ORCA_E2E_') && Boolean(env[key]))
  )
}

/** Batch AppKit open-file events into one desktop launch; one launch per file would create duplicate processes. */
export function createDesktopHandoff(options: {
  drainArguments: () => string[]
  handOff?: (args: readonly string[]) => void
}): () => void {
  const handOff = options.handOff ?? handOffToDesktopApp
  let scheduled = false
  return () => {
    if (scheduled) {
      return
    }
    scheduled = true
    setImmediate(() => {
      scheduled = false
      handOff(options.drainArguments())
    })
  }
}

/** Drains what the sidecar buffered from an open into the desktop app's launch arguments. */
export function desktopHandoffArguments(pending: {
  skillShareDeepLinks: { consume: () => string | null }
  pluginInstallLinks: { consume: () => string | null }
  osOpenedDocuments: { consume: () => string[] }
}): string[] {
  const shareId = pending.skillShareDeepLinks.consume()
  const pluginLink = pending.pluginInstallLinks.consume()
  return [
    ...(shareId ? [`orca://skills/share/${shareId}`] : []),
    ...(pluginLink ? [pluginLink] : []),
    ...pending.osOpenedDocuments.consume()
  ]
}
