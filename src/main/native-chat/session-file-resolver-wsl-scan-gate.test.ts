import { beforeEach, describe, expect, it, vi } from 'vitest'

const WSL_SESSIONS_DIR = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions'
const LOCAL_SESSIONS_DIR = 'C:\\Users\\ada\\.codex\\sessions'

const mocks = vi.hoisted(() => ({
  gate: vi.fn(async () => []),
  walk: vi.fn(
    async (
      dir: string,
      _agent: string,
      _issues: unknown[],
      options: { readDirectory?: (dirPath: string) => Promise<unknown[]> }
    ) => {
      await options.readDirectory?.(dir)
      return [] as string[]
    }
  )
}))

vi.mock('./wsl-transcript-fs-gate', () => ({
  runWslTranscriptFsTask: mocks.gate
}))
vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: mocks.walk
}))

import { resolveSessionFilePath } from './session-file-resolver'

beforeEach(() => {
  mocks.gate.mockClear()
  mocks.walk.mockClear()
})

describe('Codex WSL scan gate', () => {
  it('routes WSL session-tree scans through the shared filesystem gate', async () => {
    await resolveSessionFilePath('codex', 'session-id', {
      codexSessionsDirs: [WSL_SESSIONS_DIR]
    })

    expect(mocks.gate).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'readdir', priority: 'scan' }),
      expect.any(Function)
    )
    expect(mocks.walk).toHaveBeenCalledWith(WSL_SESSIONS_DIR, 'codex', [], expect.any(Object))
  })

  it('keeps local session-tree scans outside the WSL gate', async () => {
    await resolveSessionFilePath('codex', 'session-id', {
      codexSessionsDirs: [LOCAL_SESSIONS_DIR]
    })

    expect(mocks.gate).not.toHaveBeenCalled()
    expect(mocks.walk).toHaveBeenCalledTimes(1)
  })
})
