import { app } from 'electron'
import { dirname, resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { applyBackgroundActivationPolicy } from './foreground-activation-policy'

/**
 * orcad's browser sidecar runs from the installed app bundle. On macOS 27 LaunchServices registers
 * it even when orcad was started over SSH, and routes the user's opens (Dock, Spotlight, Finder,
 * `open`, orca:// links) to the first registered instance of the bundle, whatever its activation
 * policy. The sidecar passes each one to a new desktop instance instead of presenting its profile.
 */
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
  // Why: the empty launch environment would drop these flags and start the user's real profile.
  if (!isAutomatedLaunch(options.env ?? process.env)) {
    launchDesktopInstance(args, options.executablePath)
  }
  // Why: delivering the open promotes the sidecar into the Dock; drop back out once it is handled.
  if (options.reapplyActivationPolicy) {
    options.reapplyActivationPolicy()
  } else {
    applyBackgroundActivationPolicy({ warn: console.warn })
  }
}

function launchDesktopInstance(args: readonly string[], executablePath: string | undefined): void {
  // `Orca.app/Contents/MacOS/Orca` → `Orca.app`.
  const bundlePath = resolve(dirname(executablePath ?? app.getPath('exe')), '..', '..')
  const child = spawnProcess({
    program: '/usr/bin/open',
    args: ['-n', bundlePath, ...(args.length > 0 ? ['--args', ...args] : [])],
    // Why empty: `open` passes its environment to the app; none gives it a Dock launch's environment.
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

/**
 * Hands each batch of opens over in one launch: AppKit delivers a multi-file open as one
 * `open-file` per file, and a launch per file would start that many desktop processes.
 */
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
  osOpenedDocuments: { consume: () => string[] }
}): string[] {
  const shareId = pending.skillShareDeepLinks.consume()
  return [
    ...(shareId ? [`orca://skills/share/${shareId}`] : []),
    ...pending.osOpenedDocuments.consume()
  ]
}
