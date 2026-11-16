import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import {
  formatLocalCommandOutcome,
  parseLocalCommandTimeout,
  requestLocalCommand,
  type LocalCommandCliDeps
} from './local-command-request'
import { serveLocalCommandMcp } from './local-command-mcp'

function localCommandDeps(client: HandlerContext['client']): LocalCommandCliDeps {
  return {
    call: async <T>(method: string, params: unknown) =>
      (await client.call<T>(method, params)).result,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now
  }
}

export const LOCAL_COMMAND_HANDLERS: Record<string, CommandHandler> = {
  'local-command run': async ({ flags, client, json }) => {
    const outcome = await requestLocalCommand(
      {
        command: getRequiredStringFlag(flags, 'command'),
        cwd: getOptionalStringFlag(flags, 'cwd'),
        timeoutSec: parseLocalCommandTimeout(getOptionalStringFlag(flags, 'timeout')),
        reason: getOptionalStringFlag(flags, 'reason')
      },
      localCommandDeps(client)
    )
    const formatted = formatLocalCommandOutcome(outcome)
    console.log(json ? JSON.stringify(outcome, null, 2) : formatted.text)
    process.exitCode = formatted.isError ? 1 : 0
  },
  'local-command mcp': async ({ client }) => {
    await serveLocalCommandMcp({
      input: process.stdin,
      output: process.stdout,
      run: (input) => requestLocalCommand(input, localCommandDeps(client))
    })
  }
}
