import { runProcess, spawnProcess } from '@orca/process-host'
import { findInstalledBrowser, type BrowserLaunchCommand } from './installed-browser-catalog'

const WAITED_LAUNCH_TIMEOUT_MS = 10_000

async function runLauncherToExit(command: BrowserLaunchCommand): Promise<boolean> {
  try {
    const result = await runProcess({
      program: command.program,
      args: command.args,
      timeoutMs: WAITED_LAUNCH_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut
  } catch {
    return false
  }
}

function spawnDetachedBrowser(command: BrowserLaunchCommand): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProcess>
    try {
      child = spawnProcess({
        program: command.program,
        args: command.args,
        detached: true,
        stdio: 'ignore'
      })
    } catch {
      resolve(false)
      return
    }
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

/** False when the browser is unknown or fails to launch, so callers can fall back. */
export async function openUrlInInstalledBrowser(browserId: string, url: string): Promise<boolean> {
  const browser = await findInstalledBrowser(browserId)
  if (!browser) {
    return false
  }
  const command = browser.launchCommand(url)
  return command.waitForExit ? runLauncherToExit(command) : spawnDetachedBrowser(command)
}
