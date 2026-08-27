import { beforeEach, describe, expect, it, vi } from 'vitest'

const UBUNTU_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor\\projects'
const DEBIAN_ROOT = '\\\\wsl.localhost\\Debian\\home\\ada\\.cursor\\projects'

const mocks = vi.hoisted(() => ({
  homes: vi.fn(async () => [UBUNTU_ROOT, DEBIAN_ROOT]),
  gate: vi.fn(async (_options: { path: string }) => []),
  hostHit: null as string | null,
  guestHitRoot: null as string | null,
  walk: vi.fn(
    async (
      dir: string,
      _agent: string,
      _issues: unknown[],
      options: { readDirectory?: (dirPath: string) => Promise<unknown[]> }
    ) => {
      await options.readDirectory?.(dir)
      if (!dir.startsWith('\\\\wsl.localhost\\')) {
        return mocks.hostHit ? [mocks.hostHit] : []
      }
      return dir === mocks.guestHitRoot
        ? [`${dir}\\project\\agent-transcripts\\cursor-session.jsonl`]
        : []
    }
  )
}))

vi.mock('./host-readable-transcript-path', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  wslCursorProjectsDirs: mocks.homes
}))
vi.mock('./wsl-transcript-fs-gate', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  runWslTranscriptFsTask: mocks.gate
}))
vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: mocks.walk
}))

import { resolveSessionFilePath } from './session-file-resolver'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

beforeEach(() => {
  mocks.homes.mockClear()
  mocks.gate.mockClear()
  mocks.walk.mockClear()
  mocks.hostHit = null
  mocks.guestHitRoot = null
})

describe('Cursor WSL session resolver', () => {
  it('does not enumerate WSL homes when the host root has the transcript', async () => {
    mocks.hostHit = 'C:\\Users\\ada\\.cursor\\projects\\p\\agent-transcripts\\cursor-session.jsonl'

    await expect(resolveSessionFilePath('cursor', 'cursor-session')).resolves.toBe(mocks.hostHit)
    expect(mocks.homes).not.toHaveBeenCalled()
    expect(mocks.gate).not.toHaveBeenCalled()
  })

  it('finds a transcript under a guest Cursor projects root', async () => {
    mocks.guestHitRoot = UBUNTU_ROOT

    await expect(resolveSessionFilePath('cursor', 'cursor-session')).resolves.toBe(
      `${UBUNTU_ROOT}\\project\\agent-transcripts\\cursor-session.jsonl`
    )
    expect(mocks.gate).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'readdir', priority: 'scan' }),
      expect.any(Function)
    )
  })

  it("keeps scanning after one guest root is refused and returns another root's hit", async () => {
    const refusal = new WslTranscriptFsError('timeout', 'slow Ubuntu share')
    mocks.gate.mockImplementation(async (options: { path: string }) => {
      if (options.path.includes('Ubuntu')) {
        throw refusal
      }
      return []
    })
    mocks.guestHitRoot = DEBIAN_ROOT

    await expect(resolveSessionFilePath('cursor', 'cursor-session')).resolves.toBe(
      `${DEBIAN_ROOT}\\project\\agent-transcripts\\cursor-session.jsonl`
    )
  })

  it('reports unavailability when every guest root is refused', async () => {
    const refusal = new WslTranscriptFsError('unavailable', 'stuck permits')
    mocks.gate.mockRejectedValue(refusal)

    await expect(resolveSessionFilePath('cursor', 'cursor-session')).rejects.toBe(refusal)
  })

  it('keeps a caller abort authoritative over a guest root refusal', async () => {
    const controller = new AbortController()
    const abortReason = new Error('caller went away')
    mocks.gate.mockImplementation(async () => {
      controller.abort(abortReason)
      throw new WslTranscriptFsError('timeout', 'slow share')
    })

    await expect(
      resolveSessionFilePath('cursor', 'cursor-session', {}, controller.signal)
    ).rejects.toBe(abortReason)
  })
})
