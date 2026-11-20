import { beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'

const track = vi.fn(() => true)
vi.mock('../../telemetry/client', () => ({ track }))

beforeEach(() => {
  track.mockClear()
})

it('reports the cleanup outcome through the usage-event client, and refuses anything beyond its fields', async () => {
  const { installJournalRetirementHost } = await import('./journal-retirement-policy-live-update')
  const {
    legacyJournalRetirementEvent,
    sendLegacyJournalRetirement,
    setLegacyJournalRetirementHost
  } = await import('../agent-session-journal/journal-legacy-retirement-outcome')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = { getSettings: () => ({ telemetry: { installId: 'install' } }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only getSettings is read.
  installJournalRetirementHost(store as unknown as Store)
  const event = legacyJournalRetirementEvent({
    outcome: 'refused',
    reason: 'source-inventory',
    defer: 'none',
    artifact: 'none',
    error: 'none',
    mode: 'report',
    policy_revision: 3,
    completeness: 'partial',
    resumed: false,
    counts: null,
    sourceBytes: 23 * 1024 ** 3,
    activeMs: null,
    elapsedMs: null
  })
  await sendLegacyJournalRetirement(event)
  expect(track).toHaveBeenCalledWith('legacy_journal_retirement', event)
  // A path, or any field the schema doesn't name, never reaches the client.
  const malformed = { ...event, path: '/Users/someone/journal.db' }
  expect(await sendLegacyJournalRetirement(malformed)).toBe(false)
  expect(track).toHaveBeenCalledTimes(1)
  expect(track).not.toHaveBeenCalledWith(
    'legacy_journal_retirement',
    expect.objectContaining({ path: expect.anything() })
  )
  setLegacyJournalRetirementHost(undefined)
})
