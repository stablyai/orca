import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlaybackSuppressionRecoveryFile } from './playback-suppression-recovery-file'

let testDir: string
let markerPath: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'orca-playback-recovery-'))
  markerPath = join(testDir, 'marker.json')
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('PlaybackSuppressionRecoveryFile', () => {
  it('atomically round-trips and clears a recovery snapshot', async () => {
    const store = new PlaybackSuppressionRecoveryFile(markerPath, { now: () => 5_000 })
    const snapshot = { backend: 'wpctl', endpointId: 'speaker-1', muted: false }

    await store.write(snapshot)
    await expect(readFile(markerPath, 'utf8').then(JSON.parse)).resolves.toEqual({
      version: 1,
      createdAt: 5_000,
      snapshot
    })
    await expect(store.read()).resolves.toEqual(snapshot)
    await store.clear()
    await expect(store.read()).resolves.toBeNull()
  })

  it('removes a malformed recovery marker without changing audio state', async () => {
    const store = new PlaybackSuppressionRecoveryFile(markerPath)
    await writeFile(markerPath, '{not-json', 'utf8')

    await expect(store.read()).resolves.toBeNull()
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards stale recovery state instead of unmuting audio later', async () => {
    const store = new PlaybackSuppressionRecoveryFile(markerPath, {
      now: () => 10_000,
      maxAgeMs: 1_000
    })
    await writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        createdAt: 1,
        snapshot: { backend: 'wpctl', endpointId: 'speaker-1', muted: false }
      }),
      'utf8'
    )

    await expect(store.read()).resolves.toBeNull()
  })
})
