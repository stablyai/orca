import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WslFsAccessModule from '../../../native-chat/wsl-transcript-fs-access'
import { readCodexRolloutSessionMetaId } from './codex-rollout-session-meta'

const mocks = vi.hoisted(() => ({ readTranscriptSlice: vi.fn() }))

vi.mock('../../../native-chat/wsl-transcript-fs-access', async (importOriginal) => {
  const original = await importOriginal<typeof WslFsAccessModule>()
  mocks.readTranscriptSlice.mockImplementation(original.readTranscriptSlice)
  return { ...original, readTranscriptSlice: mocks.readTranscriptSlice }
})

let tempRoots: string[] = []

afterEach(async () => {
  mocks.readTranscriptSlice.mockClear()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('readCodexRolloutSessionMetaId', () => {
  it('reads compressed metadata without consuming the full decompressed transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-session-meta-'))
    tempRoots.push(root)
    const rollout = join(root, 'rollout.jsonl.zst')
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'compressed-id' } })
    await writeFile(rollout, zstdCompressSync(`${meta}\n${'trailing content\n'.repeat(100_000)}`))
    await expect(readCodexRolloutSessionMetaId(rollout, undefined, 'scan')).resolves.toBe(
      'compressed-id'
    )
    expect(mocks.readTranscriptSlice).toHaveBeenCalledWith(rollout, 0, 64 * 1024, 'scan', undefined)
  })

  it('refuses malformed compressed data and oversized decompressed metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-session-meta-'))
    tempRoots.push(root)
    const invalid = join(root, 'invalid.jsonl.zst')
    const oversized = join(root, 'oversized.jsonl.zst')
    await writeFile(invalid, 'invalid zstd frame')
    await writeFile(
      oversized,
      zstdCompressSync(
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'oversized', padding: 'x'.repeat(128 * 1024) }
        })
      )
    )
    await expect(readCodexRolloutSessionMetaId(invalid)).resolves.toBeNull()
    await expect(readCodexRolloutSessionMetaId(oversized)).resolves.toBeNull()
  })

  it('surfaces cancellation of a compressed read', async () => {
    const controller = new AbortController()
    mocks.readTranscriptSlice.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('compressed read aborted')
    })
    await expect(
      readCodexRolloutSessionMetaId('/fixture/rollout.jsonl.zst', controller.signal)
    ).rejects.toThrow()
  })

  it('reads the session id from the first rollout record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-session-meta-'))
    tempRoots.push(root)
    const rollout = join(root, 'rollout.jsonl')
    await writeFile(
      rollout,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-id' } })}\nignored`
    )

    await expect(readCodexRolloutSessionMetaId(rollout)).resolves.toBe('session-id')
  })

  it('returns null for a missing or malformed rollout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-session-meta-'))
    tempRoots.push(root)
    const malformed = join(root, 'malformed.jsonl')
    await writeFile(malformed, '{"type":"session_meta"')

    await expect(readCodexRolloutSessionMetaId(join(root, 'missing.jsonl'))).resolves.toBeNull()
    await expect(readCodexRolloutSessionMetaId(malformed)).resolves.toBeNull()
  })

  it('surfaces an aborted read instead of reporting an unprovable rollout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-session-meta-'))
    tempRoots.push(root)
    const rollout = join(root, 'rollout.jsonl')
    await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'aborted' } }))
    const controller = new AbortController()
    mocks.readTranscriptSlice.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('aborted')
    })

    await expect(readCodexRolloutSessionMetaId(rollout, controller.signal)).rejects.toThrow(
      'aborted'
    )
  })
})
