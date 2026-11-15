import { expect, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'

export async function waitForMobileSessionTabsEvents(
  events: RuntimeMobileSessionTabsResult[],
  count: number
): Promise<void> {
  await vi.waitFor(() => expect(events).toHaveLength(count))
}
