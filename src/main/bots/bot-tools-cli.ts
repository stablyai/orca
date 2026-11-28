// A bot's agent CLI run the way its turns run it: under the account (CODEX_HOME) the bot uses.
import { runProcess } from '@orca/process-host'
import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import { runCodexAppServerSession } from '../codex/app-server/codex-app-server-session'
import type { BotToolsCli } from './bot-tools-host'

export const CLI_TIMEOUT_MS = 60_000

const cliEnv = (cli: BotToolsCli): Record<string, string> =>
  cli.agent === 'codex' && cli.accountHome ? { ...cli.env, CODEX_HOME: cli.accountHome } : cli.env

export function runBotToolsCli(cli: BotToolsCli, args: readonly string[], cwd = cli.folder) {
  return runProcess({
    program: cli.command,
    args: [...cli.prefixArgs, ...args],
    cwd,
    env: cliEnv(cli),
    timeoutMs: CLI_TIMEOUT_MS
  })
}

export function codexSession<T>(
  cli: BotToolsCli,
  timeoutMs: number,
  body: Parameters<typeof runCodexAppServerSession<T>>[1],
  signal?: AbortSignal
): Promise<T> {
  const chatArgs = cli.chatArgs ?? { args: [] }
  if ('invalid' in chatArgs) {
    // A chat refuses these Arguments, so nothing here runs as if they were fine.
    return Promise.reject(new BotFailureError('toolCodexCheckFailed'))
  }
  return runCodexAppServerSession(
    {
      command: cli.command,
      args: [...cli.prefixArgs, ...chatArgs.args, 'app-server'],
      cwd: cli.folder,
      cliPath: cli.command,
      env: cliEnv(cli),
      timeoutMs,
      treeKillOnFinish: true,
      signal
    },
    body
  ).catch((error: unknown) => {
    // A typed reason (such as a taken name) says more than that the check failed.
    throw error instanceof BotFailureError ? error : new BotFailureError('toolCodexCheckFailed')
  })
}
