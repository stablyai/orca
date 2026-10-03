import { WSL_CLAUDE_PROFILE_POINTER_FROM_HOME } from '../../shared/claude-profile-routing'
import { runWslProcess } from '../wsl/wsl-runner'
import { readWslExeFailure } from '../wsl/wsl-exe-failure'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import {
  ClaudeProfileHostUnreachableError,
  type ClaudeProfileHostAccess
} from './claude-profile-routing-owner'
import type { ClaudeWslGuest } from './claude-profile-wsl-transport'

/** Empty selection needs only an atomic pointer, not the managed-profile runtime. */
export async function prepareClaudeWslDefaultGuest(
  distro: string,
  access: ClaudeProfileHostAccess = 'if-running'
): Promise<ClaudeWslGuest> {
  const run = async (script: string, mode: ClaudeProfileHostAccess) => {
    if (
      mode === 'if-running' &&
      !(
        await filterPathsToRunningWslDistrosAsync([toWindowsWslUncPath('/', distro)], {
          requireConfirmed: true
        })
      ).length
    ) {
      throw new ClaudeProfileHostUnreachableError(`WSL distro ${distro} is not running.`)
    }
    const result = await runWslProcess({ distro, script, loginPath: 'none', timeoutMs: 15000 })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(readWslExeFailure(result) ?? 'WSL Claude selection could not be published.')
    }
    return result.stdout.trim()
  }
  const home = await run('printf %s "$HOME"', access)
  if (!home.startsWith('/') || /[\r\n\0]/.test(home)) {
    throw new Error('WSL Claude home is unavailable.')
  }
  return {
    home,
    request: async (request, mode = 'if-running') => {
      if (request.accountId !== null) {
        throw new Error('Managed Claude profiles require the pinned guest runtime.')
      }
      if (request.action === 'publish') {
        await run(
          `umask 077; pointer="$HOME/${WSL_CLAUDE_PROFILE_POINTER_FROM_HOME}"; mkdir -p -- "$(dirname "$pointer")" && temporary=$(mktemp "$pointer.XXXXXX") && mv -f -- "$temporary" "$pointer"`,
          mode
        )
      } else if (request.action !== 'inspect') {
        throw new Error('System Default does not need profile setup.')
      }
      return { ready: true, provisioned: false, homes: [`${home}/.claude`], readiness: {} }
    }
  }
}
