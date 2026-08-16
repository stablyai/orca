import type {
  BrowserHostCommandPageState,
  BrowserHostCommandResultParams
} from './browser-host-command-state'
import { sameBrowserHostCommandResult } from './browser-host-command-state'

export function isBrowserHostReconciliationResult(
  pages: ReadonlyMap<string, BrowserHostCommandPageState>,
  params: BrowserHostCommandResultParams
): boolean {
  const page = pages.get(params.browserPageId)
  const record = page?.records.get(params.commandSequence)
  return (
    page?.generation === params.pageHostGeneration &&
    record?.event.commandId === params.commandId &&
    record.resultAdmission === 'reconciliation'
  )
}

export function hasOutstandingBrowserHostReconciliation(
  pages: ReadonlyMap<string, BrowserHostCommandPageState>
): boolean {
  for (const page of pages.values()) {
    for (const record of page.records.values()) {
      if (!record.settled && record.resultAdmission === 'reconciliation') {
        return true
      }
    }
  }
  return false
}

export function replaySettledBrowserHostCommand(
  page: BrowserHostCommandPageState,
  params: BrowserHostCommandResultParams
): false {
  const record = page.records.get(params.commandSequence)
  if (!record) {
    throw new Error('browser_host_command_result_expired')
  }
  if (
    record.event.commandId !== params.commandId ||
    !record.settled ||
    !sameBrowserHostCommandResult(record.settled, params.result)
  ) {
    throw new Error('browser_host_command_result_conflict')
  }
  return false
}
