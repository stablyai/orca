import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { getActiveMultiplexer } from './ssh'

const execFileAsync = promisify(execFile)

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
}

// Why: cache the result so repeated Landing mounts don't re-spawn processes.
// The check only runs once per app session — relaunch to re-check.
let cached: PreflightStatus | null = null

/** @internal - tests need a clean preflight cache between cases. */
export function _resetPreflightCache(): void {
  cached = null
}

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version'])
    return true
  } catch {
    return false
  }
}

// Why: `which`/`where` is faster than spawning the agent binary itself and avoids
// triggering any agent-specific startup side-effects. This gives a reliable
// PATH-based check without requiring `--version` support from each agent.
async function isCommandOnPath(command: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(finder, [command], { encoding: 'utf-8' })
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => path.isAbsolute(line))
  } catch {
    return false
  }
}

const KNOWN_AGENT_COMMANDS = Object.entries(TUI_AGENT_CONFIG).map(([id, config]) => ({
  id,
  cmd: config.detectCmd
}))

export async function detectInstalledAgents(): Promise<string[]> {
  const checks = await Promise.all(
    KNOWN_AGENT_COMMANDS.map(async ({ id, cmd }) => ({
      id,
      installed: await isCommandOnPath(cmd)
    }))
  )
  return checks.filter((c) => c.installed).map((c) => c.id)
}

export type RefreshAgentsResult = {
  /** Agents detected after hydrating PATH from the user's login shell. */
  agents: string[]
  /** PATH segments that were added this refresh (empty if nothing new). */
  addedPathSegments: string[]
  /** True when the shell spawn succeeded. False = relied on existing PATH. */
  shellHydrationOk: boolean
}

/**
 * Re-spawn the user's login shell to refresh process.env.PATH, then re-run
 * agent detection. Called by the Agents settings pane when the user clicks
 * Refresh — handles the "installed a new CLI, Orca doesn't see it yet" case
 * without requiring an app restart.
 */
export async function refreshShellPathAndDetectAgents(): Promise<RefreshAgentsResult> {
  const hydration = await hydrateShellPath({ force: true })
  const added = hydration.ok ? mergePathSegments(hydration.segments) : []
  const agents = await detectInstalledAgents()
  return {
    agents,
    addedPathSegments: added,
    shellHydrationOk: hydration.ok
  }
}

async function isGhAuthenticated(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], {
      encoding: 'utf-8'
    })
    // Why: for plain-text `gh auth status`, exit 0 means gh did not detect any
    // authentication issues for the checked hosts/accounts.
    return true
  } catch (error) {
    // Why: some environments may surface partial command output on the thrown
    // error object. Keep a compatibility fallback so we avoid a false auth
    // warning if success markers are present despite a non-zero result.
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in') || output.includes('Active account: true')
  }
}

export async function runPreflightCheck(force = false): Promise<PreflightStatus> {
  if (cached && !force) {
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
  ipcMain.handle(
    'preflight:check',
    async (_event, args?: { force?: boolean }): Promise<PreflightStatus> => {
      return runPreflightCheck(args?.force)
    }
  )

  ipcMain.handle('preflight:detectAgents', async (): Promise<string[]> => {
    return detectInstalledAgents()
  })

  ipcMain.handle('preflight:refreshAgents', async (): Promise<RefreshAgentsResult> => {
    return refreshShellPathAndDetectAgents()
  })

  // Why: remote worktrees need agent detection on the SSH host, not the local
  // machine. This handler forwards the same KNOWN_AGENT_COMMANDS list to the
  // relay's preflight.detectAgents RPC, which runs `which` inside a login shell
  // on the remote host to match the PATH users see in PTY sessions.
  ipcMain.handle(
    'preflight:detectRemoteAgents',
    async (_event, args: { connectionId: string }): Promise<string[]> => {
      const mux = getActiveMultiplexer(args.connectionId)
      if (!mux || mux.isDisposed()) {
        throw new Error(`No active SSH connection for "${args.connectionId}"`)
      }
      const result = (await mux.request('preflight.detectAgents', {
        commands: KNOWN_AGENT_COMMANDS
      })) as { agents: string[] }
      return result.agents
    }
  )
}
