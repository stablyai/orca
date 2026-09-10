import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WslFsAccessModule from '../native-chat/wsl-transcript-fs-access'
import { readCodexRolloutSessionMetaId } from './codex-rollout-session-meta'

const mocks = vi.hoisted(() => ({ readTranscriptSlice: vi.fn() }))

vi.mock('../native-chat/wsl-transcript-fs-access', async (importOriginal) => {
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

  // Why: AI Vault hands this every scan candidate, so a `\\wsl.localhost\...`
  // rollout must fail on the transcript gate's deadline rather than block the
  // scan behind a stalled distro (#15453).
  it('reads through the gated transcript filesystem at interactive priority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-session-meta-'))
    tempRoots.push(root)
    const rollout = join(root, 'rollout.jsonl')
    await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'gated' } }))
    const controller = new AbortController()

    await expect(readCodexRolloutSessionMetaId(rollout, controller.signal)).resolves.toBe('gated')

    // Default `exact`: the live-resume proof is interactive and must not queue
    // behind an AI Vault sweep of the same WSL distro.
    expect(mocks.readTranscriptSlice).toHaveBeenCalledWith(
      rollout,
      0,
      expect.any(Number),
      'exact',
      controller.signal
    )
    await expect(readCodexRolloutSessionMetaId(rollout, undefined, 'scan')).resolves.toBe('gated')
    expect(mocks.readTranscriptSlice).toHaveBeenLastCalledWith(
      rollout,
      0,
      expect.any(Number),
      'scan',
      undefined
    )
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
