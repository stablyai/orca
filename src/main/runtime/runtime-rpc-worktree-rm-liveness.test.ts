import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { openFramedSession, sleep, waitFor } from './runtime-rpc-test-harness'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

function createRemovalGate(runtime: OrcaRuntimeService) {
  let release: (() => void) | null = null
  let completed = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const removeManagedWorktree = vi
    .spyOn(runtime, 'removeManagedWorktree')
    .mockImplementation(async () => {
      await gate
      completed = true
      return {}
    })
  return {
    release: () => release?.(),
    completed: () => completed,
    removeManagedWorktree
  }
}

function startRemoval(endpoint: string, authToken: string) {
  return openFramedSession(endpoint, {
    id: 'slow-rm',
    authToken,
    method: 'worktree.rm',
    params: {
      worktree: 'path:/workspace/slow-rm',
      hostId: 'local',
      force: true,
      allowUnverifiedPtyStop: true
    }
  })
}

describe('worktree.rm runtime RPC liveness', () => {
  it('keeps the local response channel alive until removal returns', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-slow-rm-'))
    const runtime = new OrcaRuntimeService()
    const removal = createRemovalGate(runtime)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      socketIdleTimeoutMs: 100,
      keepaliveIntervalMs: 10,
      worktreeRemoveKeepaliveMaxMs: 400
    })
    await server.start()

    try {
      const metadata = readRuntimeMetadata(userDataPath)
      if (!metadata?.authToken || !metadata.transports[0]) {
        throw new Error('runtime metadata was not written')
      }
      expect(metadata.transports[0].kind).toBe(process.platform === 'win32' ? 'named-pipe' : 'unix')
      const session = startRemoval(metadata.transports[0].endpoint, metadata.authToken)
      await Promise.race([
        waitFor(() => session.frames.some((frame) => frame._keepalive === true)),
        session.done
      ])
      const keepalivesBeforeIdleWindow = session.frames.filter(
        (frame) => frame._keepalive === true
      ).length
      if (keepalivesBeforeIdleWindow > 0) {
        await sleep(150)
      }
      expect(session.frames.filter((frame) => frame.ok !== undefined)).toHaveLength(0)
      removal.release()
      await waitFor(removal.completed)
      await session.done

      expect(removal.removeManagedWorktree).toHaveBeenCalledTimes(1)
      expect(session.frames.filter((frame) => frame._keepalive === true).length).toBeGreaterThan(1)
      expect(session.frames.filter((frame) => frame._keepalive === true).length).toBeGreaterThan(
        keepalivesBeforeIdleWindow
      )
      expect(session.frames.filter((frame) => frame.ok !== undefined)).toEqual([
        expect.objectContaining({ id: 'slow-rm', ok: true })
      ])
      expect(removal.completed()).toBe(true)
    } finally {
      removal.release()
      await server.stop()
    }
  })

  it('returns one ambiguous-outcome failure when bounded liveness expires', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-slow-rm-'))
    const runtime = new OrcaRuntimeService()
    const removal = createRemovalGate(runtime)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      socketIdleTimeoutMs: 50,
      keepaliveIntervalMs: 10,
      worktreeRemoveKeepaliveMaxMs: 60
    })
    await server.start()

    try {
      const metadata = readRuntimeMetadata(userDataPath)
      if (!metadata?.authToken || !metadata.transports[0]) {
        throw new Error('runtime metadata was not written')
      }
      const session = startRemoval(metadata.transports[0].endpoint, metadata.authToken)
      await Promise.race([
        waitFor(() => session.frames.filter((frame) => frame.ok !== undefined).length === 1),
        session.done
      ])
      await session.done
      removal.release()
      await waitFor(removal.completed)

      expect(removal.removeManagedWorktree).toHaveBeenCalledTimes(1)
      expect(session.frames.filter((frame) => frame._keepalive === true).length).toBeGreaterThan(1)
      expect(session.frames.filter((frame) => frame.ok !== undefined)).toEqual([
        expect.objectContaining({
          id: 'slow-rm',
          ok: false,
          error: expect.objectContaining({
            code: 'runtime_timeout',
            data: { requestPhase: 'awaiting_response', method: 'worktree.rm' }
          })
        })
      ])
    } finally {
      removal.release()
      await server.stop()
    }
  })
})
