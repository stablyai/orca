import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
}

// Why: cache the result so repeated Landing mounts don't re-spawn processes.
// The check only runs once per app session — relaunch to re-check.
let cached: PreflightStatus | null = null

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version'])
    return true
  } catch {
    return false
  }
}

async function isGhAuthenticated(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'status'], {
      encoding: 'utf-8'
    })
    return stdout.includes('Logged in')
  } catch (error) {
    // gh auth status writes to stderr and exits 1 when not authenticated,
    // but also writes "Logged in" to stderr when authenticated on older versions.
    const stderr = (error as { stderr?: string }).stderr ?? ''
    return stderr.includes('Logged in')
  }
}

async function runPreflightCheck(): Promise<PreflightStatus> {
  if (cached) {
    return cached
  }

  const [gitInstalled, ghInstalled] = await Promise.all([
    isCommandAvailable('git'),
    isCommandAvailable('gh')
  ])

  const ghAuthenticated = ghInstalled ? await isGhAuthenticated() : false

  cached = {
    git: { installed: gitInstalled },
    gh: { installed: ghInstalled, authenticated: ghAuthenticated }
  }

  return cached
}

export function registerPreflightHandlers(): void {
  ipcMain.handle('preflight:check', async (): Promise<PreflightStatus> => {
    return runPreflightCheck()
  })
}
