import type { OrcaRuntimeService } from '../orca-runtime'
import { parsePtyStopReceipt, ptyStopReceiptProvesExit } from '../../../shared/pty-stop-receipt'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import { workerTerminalExecutionHostId } from './db/worker-terminal/worker-terminal-release-identity'

export function workerTerminalCloseReceiptProvesExit(
  close: Awaited<ReturnType<OrcaRuntimeService['closeTerminal']>>,
  resource: WorkerTerminalResourceRow
): boolean {
  const executionHostId = workerTerminalExecutionHostId(resource)
  if (
    !close ||
    !close.ptyKilled ||
    !close.ptyStopReceipt ||
    !executionHostId ||
    !resource.process_incarnation
  ) {
    return false
  }
  try {
    const receipt = parsePtyStopReceipt(close.ptyStopReceipt, {
      executionHostId,
      terminalHandle: resource.terminal_handle,
      ptyIncarnation: resource.process_incarnation
    })
    return ptyStopReceiptProvesExit(receipt)
  } catch {
    return false
  }
}
