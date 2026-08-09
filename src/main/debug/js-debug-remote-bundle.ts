import type { SshConnection } from '../ssh/ssh-connection'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { execCommand } from '../ssh/ssh-relay-exec-command'

/**
 * vscode-js-debug is staged on the *local* host by `pnpm run
 * ensure:debug-adapters` (config/scripts/vendor-js-debug-adapter.mjs). There
 * is no equivalent deployment to SSH remotes yet — this only locates a
 * bundle that's already there and fails loudly if it isn't, rather than
 * silently debugging nothing.
 *
 * Follow-up: push the bundle automatically, reusing ssh-relay-deploy.ts's
 * versioned-install pattern (src/main/ssh/ssh-relay-deploy.ts) instead of a
 * one-shot manual stage.
 */
export async function resolveRemoteJsDebugEntrypoint(connection: SshConnection): Promise<string> {
  const home = (await execCommand(connection, 'echo "$HOME"')).trim()
  if (!home) {
    throw new Error('Could not resolve the remote home directory for the js-debug adapter path')
  }
  const entrypoint = `${home}/.orca/debug-adapters/js-debug/src/dapDebugServer.js`
  const probe = (
    await execCommand(
      connection,
      `test -f ${shellEscape(entrypoint)} && echo present || echo missing`
    )
  ).trim()
  if (probe !== 'present') {
    throw new Error(
      `vscode-js-debug is not staged on the remote host at ${entrypoint}. Automatic remote deployment is not implemented yet — stage the js-debug-dap release bundle there manually, or debug from a local worktree.`
    )
  }
  return entrypoint
}
