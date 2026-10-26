import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { workerTerminalTakeoverReport } from './mobile-terminal-operations'

type ReportClient = RpcOperationSender
const REPORT_INTERVAL_MS = 30_000
const REPORT_RETRY_DELAY_MS = 250
let reportsByClient = new WeakMap<ReportClient, Map<string, number>>()

// Keep the same logical client through cutover; active UI state must not reroute the report.
export function reportWorkerTerminalUserInput(client: ReportClient, terminal: string): void {
  let reports = reportsByClient.get(client)
  if (!reports) {
    reports = new Map()
    reportsByClient.set(client, reports)
  }
  const now = Date.now()
  const last = reports.get(terminal)
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) {
    return
  }
  if (reports.size >= 256) {
    for (const [handle, reportedAt] of reports) {
      if (now - reportedAt >= REPORT_INTERVAL_MS) {
        reports.delete(handle)
      }
    }
  }
  // Gate one report per terminal/window regardless of changed count, or ordinary typing becomes one host transaction per key.
  reports.set(terminal, now)
  void sendTakeoverReport(client, terminal).catch(() => {
    if (reports.get(terminal) === now) {
      reports.delete(terminal)
    }
  })
}

async function sendTakeoverReport(client: ReportClient, terminal: string): Promise<void> {
  const report = async (): Promise<void> => {
    const reply = await workerTerminalTakeoverReport.request(
      client,
      { terminal },
      { timeoutMs: 5_000, budgetSpansConnect: true, failWhenDisconnected: true }
    )
    if (!workerTerminalTakeoverReport.interpret(reply).accepted) {
      throw new Error('Worker takeover report rejected')
    }
  }
  try {
    return await report()
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, REPORT_RETRY_DELAY_MS))
    return await report()
  }
}

export function resetWorkerTerminalTakeoverReportsForTest(): void {
  reportsByClient = new WeakMap()
}
