import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN
} from '../../shared/plugins/plugin-install-lockfile'

const execFileAsync = promisify(execFile)
const PLUGIN_GIT_TIMEOUT_MS = 120_000

/** Runs system Git with argv-only invocation so credential helpers and SSH
 * remotes work without exposing an executable remote-helper surface. */
export async function runPluginGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: PLUGIN_GIT_TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...process.env,
      // Existing non-interactive helpers and SSH agents still work, but a
      // background marketplace refresh can never hang on a terminal prompt.
      GIT_TERMINAL_PROMPT: '0'
    }
  })
  return stdout.trim()
}

/** Checks out one Git ref into an empty destination and returns exact HEAD. */
export async function checkoutPluginGitSource(input: {
  url: string
  ref: string
  destination: string
  workingDirectory: string
}): Promise<string> {
  if (!isAllowedPluginGitUrl(input.url)) {
    throw new Error('plugin Git URL must use HTTPS or SSH')
  }
  const ref = input.ref.trim()
  if (PLUGIN_COMMIT_PATTERN.test(ref)) {
    await runPluginGit(['init', '--quiet', input.destination], input.workingDirectory)
    await runPluginGit(['remote', 'add', 'origin', input.url], input.destination)
    await runPluginGit(['fetch', '--quiet', '--depth', '1', 'origin', ref], input.destination)
    await runPluginGit(['checkout', '--quiet', 'FETCH_HEAD'], input.destination)
  } else {
    const args = ['clone', '--quiet', '--depth', '1']
    if (ref.length > 0) {
      args.push('--branch', ref)
    }
    args.push('--', input.url, input.destination)
    await runPluginGit(args, input.workingDirectory)
  }
  const resolvedCommit = await runPluginGit(['rev-parse', 'HEAD'], input.destination)
  if (!PLUGIN_COMMIT_PATTERN.test(resolvedCommit)) {
    throw new Error('Git resolved an invalid commit identity')
  }
  return resolvedCommit
}
