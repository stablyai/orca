import { beforeEach, describe, expect, it, vi } from 'vitest'

const readWindowsProcess = vi.fn()

vi.mock('../windows/windows-process-lookup', () => ({ readWindowsProcess }))

const { queryWindowsProcessIdentity } = await import('./daemon-process-identity-query')

beforeEach(() => {
  readWindowsProcess.mockReset()
})

describe('queryWindowsProcessIdentity', () => {
  it('returns the command line and creation time of a present process', async () => {
    readWindowsProcess.mockResolvedValue({
      status: 'present',
      commandLine: 'Orca.exe daemon-entry.js',
      startedAtMs: 1_700_000_000_000
    })

    await expect(queryWindowsProcessIdentity(42)).resolves.toEqual({
      commandLine: 'Orca.exe daemon-entry.js',
      startedAtMs: 1_700_000_000_000
    })
    expect(readWindowsProcess).toHaveBeenCalledWith(42)
  })

  it('keeps a present process whose creation time is unavailable', async () => {
    readWindowsProcess.mockResolvedValue({
      status: 'present',
      commandLine: 'Orca.exe daemon-entry.js',
      startedAtMs: null
    })

    await expect(queryWindowsProcessIdentity(42)).resolves.toEqual({
      commandLine: 'Orca.exe daemon-entry.js',
      startedAtMs: null
    })
  })

  it.each([
    { status: 'missing' },
    { status: 'unavailable' },
    { status: 'present', commandLine: null, startedAtMs: 1 }
  ])('returns null without a readable command line (%o)', async (lookup) => {
    readWindowsProcess.mockResolvedValue(lookup)

    await expect(queryWindowsProcessIdentity(42)).resolves.toBeNull()
  })
})
