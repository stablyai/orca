import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import {
  formatLocalCommandOutcome,
  parseLocalCommandTimeout,
  requestLocalCommand,
  type LocalCommandCliDeps
} from './local-command-request'
import { serveLocalCommandMcp } from './local-command-mcp'

export const LOCAL_COMMAND_HANDLERS: Record<string, CommandHandler> = {
  'local-command run': async ({ flags, client, json }) => {
    const deps: LocalCommandCliDeps = {
      call: async <T>(method: string, params: unknown) =>
        (await client.call<T>(method, params)).result,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now
    }
    const outcome = await requestLocalCommand(
      {
        command: getRequiredStringFlag(flags, 'command'),
        cwd: getOptionalStringFlag(flags, 'cwd'),
        timeoutSec: parseLocalCommandTimeout(getOptionalStringFlag(flags, 'timeout')),
        reason: getOptionalStringFlag(flags, 'reason')
      },
      deps
    )
    const formatted = formatLocalCommandOutcome(outcome)
    console.log(json ? JSON.stringify(outcome, null, 2) : formatted.text)
    process.exitCode = formatted.isError ? 1 : 0
  },
  'local-command mcp': async ({ client }) => {
    await serveLocalCommandMcp({
      input: process.stdin,
      output: process.stdout,
      run: (input) =>
        requestLocalCommand(input, {
          call: async <T>(method: string, params: unknown) =>
            (await client.call<T>(method, params)).result,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: Date.now
        })
    })
  }
}
