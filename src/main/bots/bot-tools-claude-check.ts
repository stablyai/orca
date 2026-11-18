import { setTimeout as delay } from 'node:timers/promises'
import { openClaudeStreamJsonConnection } from '../claude/claude-stream-json-connection'
import type { BotToolProblem } from '../../shared/bot-tools'
import { claudeLaunchServers } from './bot-tools-claude'
import type { BotToolsCli } from './bot-tools-host'
import type { BotLaunchTools } from './bot-launch-tools'

export async function claudeBotToolProblems(
  cli: BotToolsCli,
  tools: BotLaunchTools,
  signal?: AbortSignal
): Promise<Map<string, BotToolProblem>> {
  const servers = tools.servers
  const connection = await openClaudeStreamJsonConnection({
    pathToClaudeCodeExecutable: cli.command,
    prefixArgs: cli.prefixArgs,
    cwd: cli.folder,
    env: cli.env,
    options: {
      settingSources: ['user', 'project', 'local'],
      settings: { disableAllHooks: true },
      mcpServers: claudeLaunchServers(tools)
    }
  })
  // Aborting closes the CLI at once, failing a status request still under way.
  const closeOnAbort = (): void => void connection.close()
  signal?.addEventListener('abort', closeOnAbort, { once: true })
  let closed = false
  let problems = new Map<string, BotToolProblem>()
  try {
    const deadline = Date.now() + 30_000
    do {
      signal?.throwIfAborted()
      problems = new Map(servers.map((server) => [server.name, { kind: 'unconfirmed' }]))
      for (const server of await connection.mcpServerStatus()) {
        if (!problems.has(server.name)) {
          continue
        }
        if (server.status === 'connected') {
          problems.delete(server.name)
        } else if (server.status === 'needs-auth') {
          problems.set(server.name, { kind: 'sign-in' })
        } else if (server.status === 'failed') {
          problems.set(server.name, { kind: 'failed' })
        }
      }
      if (![...problems.values()].some((problem) => problem.kind === 'unconfirmed')) {
        break
      }
      await delay(100, undefined, { signal })
    } while (Date.now() < deadline)
  } catch {
    signal?.throwIfAborted()
    throw new Error('Claude Code could not check the tools. Check its setup and try again.')
  } finally {
    signal?.removeEventListener('abort', closeOnAbort)
    closed = await connection.close()
  }
  if (!closed) {
    throw new Error('Claude Code tool check is still closing. Try again once it stops.')
  }
  return problems
}
