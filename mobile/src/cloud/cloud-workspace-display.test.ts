import { describe, expect, it } from 'vitest'
import { cloudSandboxHours } from './cloud-workspace-display'

const HOUR = 3_600_000

describe('cloudSandboxHours', () => {
  it('shows one decimal, two under an hour, and returns the plural count it shows', () => {
    expect(cloudSandboxHours(3.24 * HOUR)).toEqual({ value: 3.2, label: '3.2' })
    expect(cloudSandboxHours(0.25 * HOUR)).toEqual({ value: 0.25, label: '0.25' })
    expect(cloudSandboxHours(HOUR)).toEqual({ value: 1, label: '1' })
    expect(cloudSandboxHours(0)).toEqual({ value: 0, label: '0' })
  })
})
