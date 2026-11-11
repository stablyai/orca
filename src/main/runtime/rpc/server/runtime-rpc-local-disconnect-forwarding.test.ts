import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod } from '../core'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  _resetOrcadFeatureReadinessForTests,
  installOrcadFeatureReadiness
} from '../orcad-feature-readiness'

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
