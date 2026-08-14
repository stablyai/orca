import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslTranscriptFsGateModule from './wsl-transcript-fs-gate'

const WSL_SESSIONS_DIR = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions'
const DEBIAN_SESSIONS_DIR = '\\\\wsl.localhost\\Debian\\home\\ada\\.codex\\sessions'
const LOCAL_SESSIONS_DIR = 'C:\\Users\\ada\\.codex\\sessions'

const mocks = vi.hoisted(() => ({
  gate: vi.fn(async (_options: { path: string }) => []),
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

vi.mock('./wsl-transcript-fs-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslTranscriptFsGateModule>()),
  runWslTranscriptFsTask: mocks.gate
}))
vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: mocks.walk
}))

import { resolveSessionFilePath } from './session-file-resolver'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

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

  it("still surfaces a later root's hit when an earlier root is gate-refused", async () => {
    const hit = `${DEBIAN_SESSIONS_DIR}\\2026\\rollout-1-session-id.jsonl`
    mocks.gate.mockImplementation(async (options) => {
      if (options.path.includes('Ubuntu')) {
        throw new WslTranscriptFsError('timeout', 'slow share')
      }
      return []
    })
    mocks.walk.mockImplementation(async (dir, _agent, _issues, options) => {
      await options.readDirectory?.(dir)
      return dir === DEBIAN_SESSIONS_DIR ? [hit] : []
    })

    await expect(
      resolveSessionFilePath('codex', 'session-id', {
        codexSessionsDirs: [WSL_SESSIONS_DIR, DEBIAN_SESSIONS_DIR]
      })
    ).resolves.toBe(hit)
  })

  it('reports unavailability, not a miss, when every scanned root is gate-refused', async () => {
    const refusal = new WslTranscriptFsError('unavailable', 'stuck permits')
    mocks.gate.mockRejectedValue(refusal)

    await expect(
      resolveSessionFilePath('codex', 'session-id', {
        codexSessionsDirs: [WSL_SESSIONS_DIR]
      })
    ).rejects.toBe(refusal)
  })

  it('falls through a gate-refused hook path to an id-based hit', async () => {
    const hit = `${DEBIAN_SESSIONS_DIR}\\2026\\rollout-1-session-id.jsonl`
    mocks.gate.mockImplementation(async (options: { operation?: string; path: string }) => {
      if (options.operation === 'access') {
        throw new WslTranscriptFsError('timeout', 'slow share')
      }
      return []
    })
    mocks.walk.mockImplementation(async (dir, _agent, _issues, options) => {
      await options.readDirectory?.(dir)
      return dir === DEBIAN_SESSIONS_DIR ? [hit] : []
    })

    await expect(
      resolveSessionFilePath('codex', 'session-id', {
        transcriptPath: `${WSL_SESSIONS_DIR}\\2026\\rollout-1-session-id.jsonl`,
        codexSessionsDirs: [DEBIAN_SESSIONS_DIR]
      })
    ).resolves.toBe(hit)
  })

  it('surfaces the hook-path refusal when the id search also misses', async () => {
    const refusal = new WslTranscriptFsError('unavailable', 'stuck permits')
    mocks.gate.mockImplementation(async (options: { operation?: string; path: string }) => {
      if (options.operation === 'access') {
        throw refusal
      }
      return []
    })
    mocks.walk.mockImplementation(async (dir, _agent, _issues, options) => {
      await options.readDirectory?.(dir)
      return []
    })

    await expect(
      resolveSessionFilePath('codex', 'session-id', {
        transcriptPath: `${WSL_SESSIONS_DIR}\\2026\\rollout-1-session-id.jsonl`,
        codexSessionsDirs: [LOCAL_SESSIONS_DIR]
      })
    ).rejects.toBe(refusal)
  })

  it('reports the abort, not a refusal, when the hook-path probe races a caller abort', async () => {
    const controller = new AbortController()
    const abortReason = new Error('caller went away')
    mocks.gate.mockImplementation(async (options: { operation?: string; path: string }) => {
      if (options.operation === 'access') {
        controller.abort(abortReason)
        throw new WslTranscriptFsError('timeout', 'slow share')
      }
      return []
    })

    await expect(
      resolveSessionFilePath(
        'codex',
        'session-id',
        {
          transcriptPath: `${WSL_SESSIONS_DIR}\\2026\\rollout-1-session-id.jsonl`,
          codexSessionsDirs: [LOCAL_SESSIONS_DIR]
        },
        controller.signal
      )
    ).rejects.toBe(abortReason)
  })

  // The scan layer's own waiter already wins this race; the resolver's post-catch
  // signal check is the backstop if that ever stops holding.
  it('reports the abort, not a refusal, when a scanned root is aborted mid-scan', async () => {
    const controller = new AbortController()
    const abortReason = new Error('caller went away')
    mocks.gate.mockImplementation(async () => {
      controller.abort(abortReason)
      throw new WslTranscriptFsError('timeout', 'slow share')
    })

    await expect(
      resolveSessionFilePath(
        'codex',
        'session-id',
        { codexSessionsDirs: [WSL_SESSIONS_DIR] },
        controller.signal
      )
    ).rejects.toBe(abortReason)
  })
})
