import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthenticatedSourceRecorder, readNetworkSourcePolicy } from './network-source-policy-store'

describe('AuthenticatedSourceRecorder', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-network-source-policy-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('persists allowPublicSources only after a public sighting', () => {
    const recorder = new AuthenticatedSourceRecorder(userDataPath)
    for (const sourceClass of [undefined, 'loopback', 'private', 'tailnet'] as const) {
      recorder.note(sourceClass)
    }
    expect(readNetworkSourcePolicy(userDataPath)).toEqual({})

    recorder.note('public')
    expect(readNetworkSourcePolicy(userDataPath)).toEqual({ allowPublicSources: true })
  })
})
