import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { defineMethod } from './rpc/core'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  _resetOrcadFeatureReadinessForTests,
  installOrcadFeatureReadiness
} from './rpc/orcad-feature-readiness'

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

// A short RPC gets no handler signal, but a caller that disconnects mid feature-wait is never run.
it('refuses a gated short RPC whose local caller disconnects while it waits', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'local-disconnect-feature-wait-'))
  const ran = vi.fn()
  const readiness = installOrcadFeatureReadiness()
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    methods: [
      defineMethod({
        name: 'aiVault.searchStatus',
        requires: ['sessionSearch'],
        permission: 'workspace',
        params: null,
        handler: () => {
          ran()
          return {}
        }
      })
    ]
  })
  const disconnect = new AbortController()
  try {
    const pending = server['handleMessage'](
      JSON.stringify({
        id: 'req-1',
        method: 'aiVault.searchStatus',
        authToken: server['authToken']
      }),
      { signal: disconnect.signal, startKeepalive: vi.fn() }
    )
    disconnect.abort()
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_unavailable' }
    })
    readiness.open('sessionSearch')
    await Promise.resolve()
    expect(ran).not.toHaveBeenCalled()
  } finally {
    _resetOrcadFeatureReadinessForTests()
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
