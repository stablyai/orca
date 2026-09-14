import type { RpcClient } from '../transport/rpc-client'

type ReportClient = Pick<RpcClient, 'sendRequest'>
const REPORT_INTERVAL_MS = 30_000
const REPORT_RETRY_DELAY_MS = 250
let reportsByClient = new WeakMap<ReportClient, Map<string, number>>()

// The same logical client owns relay/direct cutover; never reroute a report via active UI state.
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
  // Why the gate ignores the answer: like desktop, one report per terminal per window is the
  // whole cost of typing into any terminal, worker or not. A result-aware gate that reopened on
  // "changed nothing" turned every key on an ordinary terminal into an RPC plus a host write.
  reports.set(terminal, now)
  void sendTakeoverReport(client, terminal).catch(() => {
    if (reports.get(terminal) === now) {
      reports.delete(terminal)
    }
  })
}

async function sendTakeoverReport(client: ReportClient, terminal: string): Promise<void> {
  const report = async (): Promise<void> => {
    const response = await client.sendRequest(
      'orchestration.workerTerminalUserInput',
      { terminal },
      { timeoutMs: 5_000, budgetSpansConnect: true, failWhenDisconnected: true }
    )
    if (!response.ok) {
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
