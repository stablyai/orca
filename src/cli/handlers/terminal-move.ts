import type { RuntimeTerminalMove } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatTerminalMove, printResult } from '../format'
import { getMoveTerminalHandle, getRequiredWorktreeSelector } from '../selectors'

export const terminalMoveHandler: CommandHandler = async ({ flags, client, cwd, json }) => {
  const result = await client.call<{ move: RuntimeTerminalMove }>('terminal.move', {
    terminal: getMoveTerminalHandle(flags),
    worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
    tab: flags.get('tab') === true
  })
  printResult(result, json, formatTerminalMove)
}
