import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { classifyRuntimeLongPoll } from './runtime-rpc/runtime-rpc-long-poll'

const request = { id: 'edit', authToken: 'token', method: 'files.edit' }

describe('external editor wait admission', () => {
  it.each([undefined, {}, { wait: false }, { wait: 'true' }, null])(
    'does not reserve a long-poll slot for %j',
    (params) => {
      expect(classifyRuntimeLongPoll({ ...request, params })).toBeNull()
    }
  )

  it('limits human-paced waits and keeps room for normal waits and shared specialized requests', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-editor-admission-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    try {
      for (let i = 0; i < 4; i++) {
        expect(server['admitLongPoll']('editor')).toBeNull()
      }
      expect(server['admitLongPoll']('editor')).toContain('files.edit wait capacity')
      for (let i = 0; i < 8; i++) {
        expect(server['admitLongPoll']('ask')).toBeNull()
      }
      expect(server['admitLongPoll']('browser-host')).not.toBeNull()
      for (let i = 0; i < 4; i++) {
        expect(server['admitLongPoll']('wait')).toBeNull()
      }
      expect(server['admitLongPoll']('wait')).not.toBeNull()
      server['releaseLongPoll']('editor')
      expect(server['admitLongPoll']('editor')).toBeNull()
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('returns the human-wait slot when its caller disconnects', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-editor-disconnect-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    const controller = new AbortController()
    vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (message, context) => {
      await new Promise<void>((resolve) =>
        context?.signal?.addEventListener('abort', () => resolve(), { once: true })
      )
      return { id: message.id, ok: true, result: {}, _meta: { runtimeId: runtime.getRuntimeId() } }
    })
    try {
      const response = server['handleMessage'](
        JSON.stringify({ ...request, authToken: server['authToken'], params: { wait: true } }),
        { signal: controller.signal, startKeepalive: vi.fn() }
      )
      expect(server['activeEditorLongPolls']).toBe(1)
      controller.abort()
      await response
      expect(server['activeEditorLongPolls']).toBe(0)
      expect(server['activeLongPolls']).toBe(0)
    } finally {
      controller.abort()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('passes cancellation to a nonwaiting open without a slot or keepalive', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-editor-open-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    const controller = new AbortController()
    const keepalive = vi.fn()
    const dispatch = vi.spyOn(server['dispatcher'], 'dispatch').mockResolvedValue({
      id: 'edit',
      ok: true,
      result: { closed: false },
      _meta: { runtimeId: runtime.getRuntimeId() }
    })
    try {
      await server['handleMessage'](
        JSON.stringify({
          ...request,
          authToken: server['authToken'],
          params: { filePath: '/tmp/prompt', wait: false }
        }),
        { signal: controller.signal, startKeepalive: keepalive }
      )
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ method: 'files.edit' }), {
        signal: controller.signal
      })
      expect(keepalive).not.toHaveBeenCalled()
      expect(server['activeLongPolls']).toBe(0)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
