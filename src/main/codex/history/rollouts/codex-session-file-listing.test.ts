import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCodexSessionJsonlFilesIncrementally } from './codex-session-file-listing'
import { listCodexSessionBackfillFilesForDates } from '../backfill/codex-session-backfill-date'
import type { CodexSessionBackfillDate } from '../backfill/codex-session-backfill-types'

let tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
  vi.restoreAllMocks()
})

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-listing-'))
  tempRoots.push(root)
  return root
}

async function collect(files: AsyncGenerator<string>): Promise<string[]> {
  const collected: string[] = []
  for await (const filePath of files) {
    collected.push(filePath)
  }
  return collected
}

describe('listCodexSessionJsonlFilesIncrementally', () => {
  it('warns when a directory fails and no handler owns the error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingRoot = join(makeTempRoot(), 'sessions', '2026', '11', '13')

    const files = await collect(
      listCodexSessionJsonlFilesIncrementally(missingRoot, { batchSize: 8, yieldMs: 0 })
    )

    expect(files).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-session-bridge] Failed to list system Codex sessions:',
      expect.objectContaining({ code: 'ENOENT' })
    )
  })

  it('lets the handler own an absent scan root instead of warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingRoot = join(makeTempRoot(), 'sessions', '2026', '11', '13')
    const handled: [string, unknown][] = []

    const files = await collect(
      listCodexSessionJsonlFilesIncrementally(
        missingRoot,
        { batchSize: 8, yieldMs: 0 },
        async (directoryPath, error) => {
          handled.push([directoryPath, error])
        }
      )
    )

    expect(files).toEqual([])
    expect(handled).toEqual([[missingRoot, expect.objectContaining({ code: 'ENOENT' })]])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('yields session files from an existing tree without consulting the handler', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = makeTempRoot()
    const sessionDir = join(root, 'sessions', '2026', '11', '13')
    mkdirSync(sessionDir, { recursive: true })
    const sessionFile = join(sessionDir, 'rollout-2026-11-13T10-00-00-00000000-abc.jsonl')
    writeFileSync(sessionFile, '{}\n', 'utf-8')
    const handled: [string, unknown][] = []

    const files = await collect(
      listCodexSessionJsonlFilesIncrementally(
        root,
        { batchSize: 8, yieldMs: 0 },
        async (directoryPath, error) => {
          handled.push([directoryPath, error])
        }
      )
    )

    expect(files).toEqual([sessionFile])
    expect(handled).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('listCodexSessionBackfillFilesForDates', () => {
  it('treats pending dates without a session folder as empty and stays quiet', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sessionsRoot = join(makeTempRoot(), 'sessions')
    const scanDates: readonly CodexSessionBackfillDate[] = [
      ['2026', '11', '12'],
      ['2026', '11', '13']
    ]
    const forwarded: [string, unknown][] = []

    const files = await collect(
      listCodexSessionBackfillFilesForDates(
        sessionsRoot,
        { batchSize: 8, yieldMs: 0, scanDates },
        async (directoryPath, error) => {
          forwarded.push([directoryPath, error])
        }
      )
    )

    expect(files).toEqual([])
    // Session folders only exist for days that had sessions; absence is not a scan failure.
    expect(forwarded).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
