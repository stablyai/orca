import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { defineMethod } from './rpc/core'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

it.each(['browser.eval', 'linear.commentEdit', 'linear.commentDelete'] as const)(
  'forwards local disconnect to %s without long-poll keepalives',
  async (method) => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'local-disconnect-forwarding-'))
    const entered = vi.fn()
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      methods: [
        defineMethod({
          name: method,
          permission: 'workspace',
          params: null,
          handler: async (_params, { signal }) => {
            entered(signal)
            await new Promise<void>((resolve) =>
              signal?.addEventListener('abort', () => resolve(), { once: true })
            )
            return { cancelled: signal?.aborted }
          }
        })
      ]
    })
    const cancellation = new AbortController()
    const startKeepalive = vi.fn()
    try {
      const pending = server['handleMessage'](
        JSON.stringify({ id: 'req-1', method, authToken: server['authToken'] }),
        { signal: cancellation.signal, startKeepalive }
      )
      await vi.waitFor(() => expect(entered).toHaveBeenCalledWith(cancellation.signal))
      cancellation.abort()
      await expect(pending).resolves.toMatchObject({ ok: true, result: { cancelled: true } })
      expect(startKeepalive).not.toHaveBeenCalled()
    } finally {
      cancellation.abort()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }
)
