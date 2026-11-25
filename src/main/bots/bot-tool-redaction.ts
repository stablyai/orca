import type { BotToolProblem, BotToolServer } from '../../shared/bot-tools'

export function redactBotToolText(text: string, servers: readonly BotToolServer[]): string {
  const secrets = servers
    .flatMap((server) => Object.values(('url' in server ? server.headers : server.env) ?? {}))
    .filter(Boolean)
  return secrets
    .sort((a, b) => b.length - a.length)
    .reduce((value, secret) => value.split(secret).join('[redacted]'), text)
}

export function redactBotToolProblems(
  problems: Map<string, BotToolProblem>,
  servers: readonly BotToolServer[]
): Record<string, BotToolProblem> {
  return Object.fromEntries(
    [...problems].map(([name, problem]) => [
      name,
      problem.detail ? { ...problem, detail: redactBotToolText(problem.detail, servers) } : problem
    ])
  )
}
