import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string

beforeEach(async () => {
  vi.resetModules()
  dir = await mkdtemp(join(tmpdir(), 'orca-drive-answers-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('mapped-drive answers file', () => {
  it('keeps how each answer was learned across launches, and reads files saved without it', async () => {
    const answersFile = await import('./wsl-mapped-drive-answers-file')
    const lastKnown = await import('./wsl-mapped-drive-last-known')
    await writeFile(
      answersFile.wslMappedDriveAnswersPath(dir),
      JSON.stringify({ version: 1, answers: [{ letter: 'E', share: null, at: 1 }] })
    )
    const { saved } = await answersFile.loadWslMappedDriveAnswers(dir)
    lastKnown.rememberWslMappedDriveRead('D', 'D:\\', 2)
    lastKnown.rememberWslMappedDriveFailure('F', 3)
    await saved()
    const body = JSON.parse(await readFile(answersFile.wslMappedDriveAnswersPath(dir), 'utf8'))
    expect(body.answers).toEqual(
      expect.arrayContaining([
        { letter: 'E', share: null, at: 1 },
        { letter: 'D', share: null, at: 2, lookup: 'read' },
        { letter: 'F', share: null, at: 3, lookup: 'failed' }
      ])
    )
    vi.resetModules()
    const relaunched = await import('./wsl-mapped-drive-answers-file')
    const relaunchedKnown = await import('./wsl-mapped-drive-last-known')
    await relaunched.loadWslMappedDriveAnswers(dir)
    expect(relaunchedKnown.wslMappedDriveLastKnownShare('D')).toEqual({
      share: null,
      lookup: 'read'
    })
    expect(relaunchedKnown.wslMappedDriveLastKnownShare('F')).toEqual({
      share: null,
      lookup: 'failed'
    })
    expect(relaunchedKnown.wslMappedDriveLastKnownShare('E')).toEqual({ share: null })
  })
})

describe('onNextWslMappedDriveAnswer', () => {
  it('fires once, on the next settled answer', async () => {
    const lastKnown = await import('./wsl-mapped-drive-last-known')
    const listener = vi.fn()
    lastKnown.onNextWslMappedDriveAnswer(listener)
    expect(listener).not.toHaveBeenCalled()
    lastKnown.rememberWslMappedDriveRead('D', 'D:\\', 1)
    lastKnown.rememberWslMappedDriveFailure('F', 2)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
