import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelCodeIntelQuery, handleCodeIntelQuery } from './code-intel'
import * as sidecar from '../code-intel/sidecar-client'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

afterEach(() => vi.restoreAllMocks())

describe('handleCodeIntelQuery', () => {
  it('returns unsupported:remote-runtime when a connectionId is present', async () => {
    const result = await handleCodeIntelQuery('references', {
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      position: { line: 0, character: 0 },
      bufferVersion: 0,
      connectionId: 'ssh-123'
    })
    expect(result).toEqual({ status: 'unsupported', reason: 'remote-runtime' })
  })

  it('delegates local queries to the sidecar', async () => {
    const query = vi.fn().mockResolvedValue({ status: 'ok', locations: [], truncated: false })
    vi.spyOn(sidecar, 'getCodeIntelSidecar').mockReturnValue({ query } as never)
    const result = await handleCodeIntelQuery('definition', {
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      position: { line: 0, character: 0 },
      bufferVersion: 0
    })
    expect(query).toHaveBeenCalledOnce()
    expect(result).toEqual({ status: 'ok', locations: [], truncated: false })
  })

  it('aborts the in-flight sidecar query when cancelled by request id', async () => {
    let captured: AbortSignal | undefined
    const query = vi.fn((_method, _params, signal: AbortSignal) => {
      captured = signal
      // Never resolves: the request stays in flight until aborted.
      return new Promise<never>(() => {})
    })
    vi.spyOn(sidecar, 'getCodeIntelSidecar').mockReturnValue({ query } as never)

    void handleCodeIntelQuery(
      'definition',
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        position: { line: 0, character: 0 },
        bufferVersion: 0,
        requestId: 42
      },
      7
    )

    expect(captured?.aborted).toBe(false)
    cancelCodeIntelQuery(7, 42)
    expect(captured?.aborted).toBe(true)
  })
})
