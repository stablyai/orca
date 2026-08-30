import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import type { BrowserHostCommandPageState } from './browser-host-command-state'

export function replayOutstandingBrowserHostCommands(
  pages: Iterable<BrowserHostCommandPageState>,
  delivery: (event: BrowserClientHostCommandEvent) => unknown
): void {
  for (const page of pages) {
    for (const record of page.records.values()) {
      if (!record.settled) {
        if (delivery(record.event) === false) {
          throw new Error('browser_host_command_replay_not_admitted')
        }
      }
    }
  }
}
