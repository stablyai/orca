import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { attachToTerminalDaemon } from '../runtime/terminal-daemon-attach'
import { getTerminalHandle } from '../selectors'

export const terminalAttachHandler: CommandHandler = async ({ flags, client, cwd, json }) => {
  if (json) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--json is not supported for terminal attach; the command is an interactive PTY bridge.'
    )
  }
  if (client.isRemote) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'terminal attach is local-only: this CLI is paired with a remote runtime, whose terminals live on the remote host. Run `orca terminal attach` on the remote host itself, or use the Orca desktop UI.'
    )
  }
  const handle = await getTerminalHandle(flags, cwd, client)
  await attachToTerminalDaemon(handle, { readOnly: flags.get('read-only') === true })
}
