import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { reportWorkerTakeoverOncePerWindow } from '../../../src/shared/worker-terminal-takeover-report-gate'
import { workerTerminalTakeoverReport } from './mobile-terminal-operations'

type ReportClient = RpcOperationSender
let reportsByClient = new WeakMap<ReportClient, Map<string, number>>()

// Keep the same logical client through cutover; active UI state must not reroute the report.
export function reportWorkerTerminalUserInput(client: ReportClient, terminal: string): void {
  let reports = reportsByClient.get(client)
  if (!reports) {
    reports = new Map()
    reportsByClient.set(client, reports)
  }
  reportWorkerTakeoverOncePerWindow(reports, terminal, async () => {
    const reply = await workerTerminalTakeoverReport.request(
      client,
      { terminal },
      { timeoutMs: 5_000, budgetSpansConnect: true, failWhenDisconnected: true }
    )
    if (!workerTerminalTakeoverReport.interpret(reply).accepted) {
      throw new Error('Worker takeover report rejected')
    }
  })
}

export function resetWorkerTerminalTakeoverReportsForTest(): void {
  reportsByClient = new WeakMap()
}
