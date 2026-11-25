import type { BotToolProblem, BotToolServer } from '../../shared/bot-tools'

/** The servers' saved values, longest first, so a value inside another never leaves part of it. */
function botToolSecrets(servers: readonly BotToolServer[]): string[] {
  return servers
    .flatMap((server) => Object.values(('url' in server ? server.headers : server.env) ?? {}))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
}

const redacted = (text: string, secrets: readonly string[]): string =>
  secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text)

export function redactBotToolText(text: string, servers: readonly BotToolServer[]): string {
  return redacted(text, botToolSecrets(servers))
}

export function redactBotToolProblems(
  problems: Map<string, BotToolProblem>,
  servers: readonly BotToolServer[]
): Record<string, BotToolProblem> {
  const secrets = botToolSecrets(servers)
  return Object.fromEntries(
    [...problems].map(([name, problem]) => [
      name,
      problem.detail ? { ...problem, detail: redacted(problem.detail, secrets) } : problem
    ])
  )
}
