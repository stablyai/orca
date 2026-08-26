import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import type { BrowserHostCommandPageState } from './browser-host-command-state'

export function replayOutstandingBrowserHostCommands(
  pages: Iterable<BrowserHostCommandPageState>,
  delivery: (event: BrowserClientHostCommandEvent) => void
): void {
  for (const page of pages) {
    for (const record of page.records.values()) {
      if (!record.settled) {
        delivery(record.event)
      }
    }
  }
}
