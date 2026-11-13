import { describe, expect, it } from 'vitest'
import type { Translate } from '../i18n/mobile-i18n'
import { cloudSandboxHours, cloudSpendLine } from './cloud-workspace-display'

const HOUR = 3_600_000

describe('cloudSandboxHours', () => {
  it('shows one decimal, two under an hour, and returns the plural count it shows', () => {
    expect(cloudSandboxHours(3.24 * HOUR)).toEqual({ value: 3.2, label: '3.2' })
    expect(cloudSandboxHours(0.25 * HOUR)).toEqual({ value: 0.25, label: '0.25' })
    expect(cloudSandboxHours(HOUR)).toEqual({ value: 1, label: '1' })
    expect(cloudSandboxHours(0)).toEqual({ value: 0, label: '0' })
  })
})

describe('cloudSpendLine', () => {
  const t: Translate = (_key, fallback) => fallback
  it('says an archived workspace uses no hours, not that it is asleep', () => {
    const line = cloudSpendLine({ status: 'archived', sandboxMs: 3_600_000 }, null, false, t)
    expect(line).toBe('{{hours}} sandbox hours used. Archived workspaces don’t use sandbox hours.')
  })

  it('keeps the asleep and running lines', () => {
    expect(cloudSpendLine({ status: 'sleeping', sandboxMs: 1 }, null, false, t)).toContain(
      'while asleep'
    )
    expect(cloudSpendLine({ status: 'running', sandboxMs: 1 }, null, true, t)).toContain(
      'while running'
    )
    expect(cloudSpendLine({ status: 'running', sandboxMs: null }, null, true, t)).toBeNull()
  })
})
