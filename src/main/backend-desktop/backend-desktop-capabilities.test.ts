import { beforeEach, expect, it, vi } from 'vitest'
import { legacyJournalRetirementEvent } from '../native-chat/agent-session-journal/journal-legacy-retirement-outcome'

const track = vi.fn(() => true)
vi.mock('../telemetry/client', () => ({ track, isTelemetryEnabled: () => true }))

beforeEach(() => {
  track.mockClear()
})

it('forwards the old-history cleanup outcome and refuses anything beyond its fixed fields', async () => {
  const { createBackendDesktopCapabilities } = await import('./backend-desktop-capabilities')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this capability never reads the worktree store.
  const call = createBackendDesktopCapabilities(
    {} as Parameters<typeof createBackendDesktopCapabilities>[0]
  )
  const event = legacyJournalRetirementEvent({
    outcome: 'refused',
    reason: 'source-inventory',
    defer: 'none',
    artifact: 'source_json',
    mode: 'report',
    policy_revision: 3,
    completeness: 'partial',
    resumed: false,
    counts: null,
    sourceBytes: 23 * 1024 ** 3,
    activeMs: null
  })
  await expect(call('journal.legacyRetirement.capture', event)).resolves.toBe(true)
  expect(track).toHaveBeenCalledWith('legacy_journal_retirement', event)
  // A path, or any field the schema doesn't name, never reaches the client.
  await expect(
    call('journal.legacyRetirement.capture', {
      ...event,
      path: '/Users/someone/agent-session-journal.db'
    })
  ).rejects.toThrow()
  expect(track).toHaveBeenCalledTimes(1)
})
