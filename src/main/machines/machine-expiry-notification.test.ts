import { describe, expect, it, vi } from 'vitest'

vi.mock('../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

import { machineExpiryNotification } from './machine-expiry-notification'

const warning = {
  providerKey: 'plugin:acme.omarchy/omarchy' as const,
  machineId: 'sbx-1',
  name: 'pr-2231',
  expiresAt: Date.parse('2026-10-19T16:12:00Z')
}

describe('machineExpiryNotification', () => {
  it('says unsaved work could not be checked rather than leaving it out', () => {
    const banner = machineExpiryNotification({ ...warning, workAtRisk: null })
    expect(banner.title).toMatch(/^pr-2231 deletes at /)
    expect(banner.body).toBe('Orca couldn’t check for unsaved work on it.')
  })

  it('counts the work at risk, and says when there is none', () => {
    expect(
      machineExpiryNotification({ ...warning, workAtRisk: { uncommitted: 2, unpushed: 3 } }).body
    ).toBe('2 uncommitted changes, 3 unpushed commits on it will be lost unless you push first.')
    expect(
      machineExpiryNotification({ ...warning, workAtRisk: { uncommitted: 1, unpushed: 0 } }).body
    ).toBe('1 uncommitted change on it will be lost unless you push first.')
    expect(
      machineExpiryNotification({ ...warning, workAtRisk: { uncommitted: 0, unpushed: 1 } }).body
    ).toBe('1 unpushed commit on it will be lost unless you push first.')
    expect(
      machineExpiryNotification({ ...warning, workAtRisk: { uncommitted: 0, unpushed: 0 } }).body
    ).toMatch(/no uncommitted or unpushed work/)
  })
})
