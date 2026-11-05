import { expect, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

export async function waitForMobileSessionTabsEvents(
  events: RuntimeMobileSessionTabsResult[],
  count: number
): Promise<void> {
  await vi.waitFor(() => expect(events).toHaveLength(count))
}
