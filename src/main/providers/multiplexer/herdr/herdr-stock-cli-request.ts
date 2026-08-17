import { randomUUID } from 'node:crypto'
import type { HerdrResponse } from './herdr-runtime-contract'
import { herdrStockCliArgs } from './herdr-stock-cli-args'

export type HerdrStockCliInvocation = {
  args: string[]
  parse: (stdout: string) => HerdrResponse<unknown>
}

export function herdrStockCliInvocation(
  sessionName: string,
  method: string,
  rawParams: unknown
): HerdrStockCliInvocation {
  const args = ['--session', sessionName, ...herdrStockCliArgs(method, rawParams)]

  switch (method) {
    case 'pane.read':
    case 'agent.read':
      return {
        args,
        parse: (stdout) => ({
          id: randomUUID(),
          result: { read: { text: stdout, revision: 0 } }
        })
      }
    case 'workspace.report_metadata':
    case 'pane.send_keys':
    case 'pane.send_text':
    case 'pane.report_metadata':
    case 'pane.report_agent':
    case 'pane.report_agent_session':
    case 'pane.release_agent':
    case 'pane.close':
    case 'pane.rename':
    case 'pane.focus':
    case 'agent.rename':
    case 'agent.focus':
    case 'agent.start':
    case 'agent.prompt':
    case 'agent.send_keys':
    case 'workspace.close':
    case 'workspace.focus':
    case 'tab.close':
    case 'tab.focus':
    case 'worktree.remove':
    case 'server.live_handoff':
      return okInvocation(args)
    default:
      return jsonInvocation(args)
  }
}

function jsonInvocation(args: string[]): HerdrStockCliInvocation {
  return {
    args,
    parse: (stdout) => JSON.parse(stdout.trim()) as HerdrResponse<unknown>
  }
}

function okInvocation(args: string[]): HerdrStockCliInvocation {
  return {
    args,
    parse: (stdout) =>
      stdout.trim()
        ? (JSON.parse(stdout.trim()) as HerdrResponse<unknown>)
        : { id: randomUUID(), result: { type: 'ok' } }
  }
}
