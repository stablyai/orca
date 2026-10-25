import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestSupervisedServeStop, resetSupervisedServeStop } from './serve-supervised-stop'
import { resumeInterruptedServeUpdate } from './serve-update-supervisor'

const HANDOFF = {
  schemaVersion: 1 as const,
  phase: 'install-requested' as const,
  fromVersion: '1.0.0',
  targetVersion: '1.1.0',
  servingPid: 42
}

describe('supervised update replacement spawns', () => {
  afterEach(() => {
    resetSupervisedServeStop()
    vi.restoreAllMocks()
  })

  async function resume(): Promise<{ code: number; spawnChild: ReturnType<typeof vi.fn> }> {
    const root = await mkdtemp(join(tmpdir(), 'orca-update-gate-'))
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const spawnChild = vi.fn()
    try {
      const code = await resumeInterruptedServeUpdate({
        spec: { program: join(root, 'orca') },
        spawnChild,
        handoffPath: join(root, 'handoff.json'),
        handoff: HANDOFF
      })
      return { code, spawnChild }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('does not spawn a replacement when the install hold says stop', async () => {
    const gate = vi.fn(async () => false)
    resetSupervisedServeStop(gate)
    const { code, spawnChild } = await resume()
    expect(code).toBe(0)
    expect(gate).toHaveBeenCalledOnce()
    expect(spawnChild).not.toHaveBeenCalled()
  })

  it('does not spawn a replacement after a stop request', async () => {
    resetSupervisedServeStop(async () => true)
    requestSupervisedServeStop()
    const { code, spawnChild } = await resume()
    expect(code).toBe(0)
    expect(spawnChild).not.toHaveBeenCalled()
  })
})
