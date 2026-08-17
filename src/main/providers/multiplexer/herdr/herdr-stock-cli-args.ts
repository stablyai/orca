import { workspaceCliArgs } from './herdr-stock-cli-args-workspace'
import { paneCliArgs } from './herdr-stock-cli-args-pane'
import { agentCliArgs } from './herdr-stock-cli-args-agent'
import { sessionCliArgs } from './herdr-stock-cli-args-session'

export function herdrStockCliArgs(method: string, rawParams: unknown): string[] {
  const workspace = workspaceCliArgs(method, rawParams)
  if (workspace) {
    return workspace
  }

  const pane = paneCliArgs(method, rawParams)
  if (pane) {
    return pane
  }

  const agent = agentCliArgs(method, rawParams)
  if (agent) {
    return agent
  }

  const session = sessionCliArgs(method, rawParams)
  if (session) {
    return session
  }

  throw new Error(`Unsupported stock Herdr CLI request: ${method}`)
}
