// All three walking resolvers use only `files[0]`, and each runs on every
// acquisition, so each must hand the scan its early exit. Nothing else pins that
// wiring: drop the option and a resolver still returns the right file, just
// after walking every transcript in the home.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const scanned = vi.hoisted(() => ({
  calls: [] as { dir: string; stopAfterFirstMatch: unknown }[]
}))

vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: async (
    dir: string,
    _agent: string,
    _issues: unknown[],
    options: { stopAfterFirstMatch?: boolean }
  ) => {
    scanned.calls.push({ dir, stopAfterFirstMatch: options.stopAfterFirstMatch })
    return []
  }
}))

import { resolveSessionFilePath } from './session-file-resolver'

beforeEach(() => {
  scanned.calls = []
})

describe('session file resolvers stop at the first match', () => {
  it.each(['claude', 'codex', 'omp'] as const)('asks the %s scan to stop early', async (agent) => {
    await resolveSessionFilePath(agent, 'session-1')

    expect(scanned.calls.length).toBeGreaterThan(0)
    expect(scanned.calls.map((call) => call.stopAfterFirstMatch)).toEqual(
      scanned.calls.map(() => true)
    )
  })
})
