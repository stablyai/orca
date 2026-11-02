import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '', matching: new Set<string>() }))
vi.mock('../hermes/hermes-default-home', () => ({ getHermesHome: () => state.home }))
vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', () => ({
  readOpenCodeTranscriptSignalViaWorker: async ({ dbPath }: { dbPath: string }) =>
    state.matching.has(dbPath)
      ? { messageCount: 1, partCount: 0, maxMessageRowId: 1, maxPartTimeUpdated: 1 }
      : null,
  readOpenCodeTranscriptPageViaWorker: vi.fn()
}))

import { canReadHermesTranscriptHere, hermesTranscriptDeps } from './transcript-hermes'

afterEach(() => {
  if (state.home) {
    rmSync(state.home, { recursive: true, force: true })
  }
  state.home = ''
  state.matching.clear()
})

describe('Hermes transcript source', () => {
  it('does not resolve a local database for an SSH or WSL session', () => {
    expect(canReadHermesTranscriptHere({})).toBe(true)
    expect(canReadHermesTranscriptHere({ wslDistro: 'Ubuntu' })).toBe(false)
    expect(
      canReadHermesTranscriptHere({ transcriptPath: 'orca-ssh-transcript:host:%2Ftmp%2Fsession' })
    ).toBe(false)
  })

  it('finds the exact session in a named profile and refuses ambiguous copies', async () => {
    state.home = mkdtempSync(join(tmpdir(), 'orca-hermes-home-'))
    const defaultDb = join(state.home, 'state.db')
    const profile = join(state.home, 'profiles', 'work')
    const profileDb = join(profile, 'state.db')
    mkdirSync(profile, { recursive: true })
    writeFileSync(defaultDb, '')
    writeFileSync(profileDb, '')
    state.matching.add(profileDb)
    const session = '20261031_144415_71256d'
    await expect(hermesTranscriptDeps.resolveDbPath?.(session)).resolves.toBe(profileDb)
    state.matching.add(defaultDb)
    await expect(hermesTranscriptDeps.resolveDbPath?.(session)).resolves.toBeNull()
    await expect(hermesTranscriptDeps.resolveDbPath?.('../state.db')).resolves.toBeNull()
  })
})
