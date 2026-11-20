import { expect, it } from 'vitest'
import {
  effectiveJournalRetirementMode,
  journalRetirementBucket,
  parseJournalRetirementPolicy,
  type JournalRetirementPolicy
} from './journal-retirement-policy'

const policy = (fields: Partial<JournalRetirementPolicy>): JournalRetirementPolicy => ({
  version: 1,
  revision: 2,
  mode: 'enforce',
  enforcePermille: 1000,
  ...fields
})
const DAY = 24 * 60 * 60 * 1000

it('deletes only with a fresh download that enforces for this install, and never past a known off', () => {
  const now = 10 * DAY
  const base = { newestKnown: null, now, platform: 'darwin' as const, installId: 'install' }
  const fetched = (p: JournalRetirementPolicy, at = now) => ({ policy: p, downloaded: p, at })

  // Nothing downloaded, or a download over a day old: report, never delete.
  expect(effectiveJournalRetirementMode({ ...base, fetched: null }).mode).toBe('report')
  expect(
    effectiveJournalRetirementMode({ ...base, fetched: fetched(policy({}), now - DAY - 1) }).mode
  ).toBe('report')
  expect(effectiveJournalRetirementMode({ ...base, fetched: fetched(policy({})) })).toEqual({
    mode: 'enforce',
    revision: 2
  })
  // The newest known off holds over an older enforce downloaded since.
  expect(
    effectiveJournalRetirementMode({
      ...base,
      fetched: fetched(policy({ revision: 1 })),
      newestKnown: policy({ revision: 3, mode: 'off' })
    }).mode
  ).toBe('off')
  // Only the cohort and the platforms it names.
  const bucket = journalRetirementBucket('install')
  expect(
    effectiveJournalRetirementMode({
      ...base,
      fetched: fetched(policy({ enforcePermille: bucket }))
    }).mode
  ).toBe('report')
  expect(
    effectiveJournalRetirementMode({ ...base, fetched: fetched(policy({ platforms: ['win32'] })) })
      .mode
  ).toBe('report')
  // Each platform at its own share: this platform's entry replaces the shared one.
  const shares = { darwin: bucket + 1, win32: 0 }
  expect(
    effectiveJournalRetirementMode({
      ...base,
      fetched: fetched(policy({ enforcePermille: 0, platformPermille: shares }))
    }).mode
  ).toBe('enforce')
  expect(
    effectiveJournalRetirementMode({
      ...base,
      platform: 'win32',
      fetched: fetched(policy({ enforcePermille: 1000, platformPermille: shares }))
    }).mode
  ).toBe('report')
  // A malformed entry or map holds that platform back rather than falling to the shared share.
  for (const platformPermille of [
    { darwin: '1000' },
    { darwin: null },
    { darwin: 1000, Win32: 0 },
    [1000],
    'all'
  ]) {
    expect(
      effectiveJournalRetirementMode({
        ...base,
        fetched: fetched(policy({ enforcePermille: 1000, platformPermille }))
      }).mode
    ).toBe('report')
  }
  const parsedShares = parseJournalRetirementPolicy(
    '{"version":1,"revision":7,"mode":"enforce","enforcePermille":1000,"platformPermille":{"darwin":0,"win32":"10"}}'
  )
  expect(
    parsedShares.ok &&
      effectiveJournalRetirementMode({ ...base, fetched: fetched(parsedShares.policy) }).mode
  ).toBe('report')
  expect(
    effectiveJournalRetirementMode({ ...base, installId: undefined, fetched: fetched(policy({})) })
      .mode
  ).toBe('report')
  // A malformed mode reads as report, and an oversized file is rejected.
  const parsed = parseJournalRetirementPolicy('{"version":1,"revision":4,"mode":"delete"}')
  expect(parsed.ok && parsed.policy.mode).toBe('report')
  expect(parseJournalRetirementPolicy(' '.repeat(17 * 1024)).ok).toBe(false)
})
