// The checks that start a bot's servers to see what needs signing in: one per bot, agent and scope
// at a time, shared by whoever asks meanwhile, and stopped when the window that asked lets go.

import type { BotToolProblem } from '../../shared/bot-tools'

type Problems = Record<string, BotToolProblem>
type Check = { botId: string; controller: AbortController; result: Promise<Problems> }

const checks = new Map<string, Check>()

/** Runs `run`, or joins the same check already under way. */
export function sharedBotToolHealthCheck(
  botId: string,
  key: string,
  run: (signal: AbortSignal) => Promise<Problems>
): Promise<Problems> {
  const id = `${botId}\0${key}`
  const running = checks.get(id)
  if (running) {
    return running.result
  }
  const controller = new AbortController()
  const result = run(controller.signal).finally(() => {
    if (checks.get(id)?.controller === controller) {
      checks.delete(id)
    }
  })
  checks.set(id, { botId, controller, result })
  return result
}

/** Stops the bot's checks under way; their servers and CLI session close with them. */
export function cancelBotToolHealthChecks(botId: string): void {
  for (const [id, check] of checks) {
    if (check.botId === botId) {
      check.controller.abort()
      checks.delete(id)
    }
  }
}
