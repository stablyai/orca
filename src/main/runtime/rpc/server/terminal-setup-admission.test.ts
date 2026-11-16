import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { defineOrchestrationMethod } from '../methods/orchestration/access/orchestration-method-access'
import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './pairing/device-registry'
import { defineMethod, type RpcResponse } from '../core'
import { TERMINAL_QUERY_METHODS } from '../methods/terminal/terminal-query-methods'
import { TerminalSetupObservers } from '../../../../renderer/src/runtime/hosted-terminals/inspection/terminal-setup-observers'
import { isTerminalSetupStatus } from '../../../../shared/terminal/pty/lifecycle/terminal-setup-status'

class SetupHost extends OrcaRuntimeService {
  bindSetup(id: string, completion: Promise<{ exitCode: number | null }>): void {
    this.setupTerminalCompletions.bindDependent('workspace', id, completion)
  }
  override getTerminalSetupStatus(handle: string) {
    return this.getPtySetupStatus(handle)
  }
}

class PairedServer extends OrcaRuntimeRpcServer {
  pair(path: string): string {
    this.deviceRegistry = new DeviceRegistry(path)
    return this.deviceRegistry.addDevice('setup-observer', 'runtime').token
  }
  request(token: string, id: string, method: string): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      void this.handleWebSocketMessage(
        JSON.stringify({
          id,
          method,
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
          params: { terminal: id, ...(method === 'agent.launch' ? { prompt: 'hello' } : {}) }
        }),
        (response) => resolve(JSON.parse(response)),
        () => {},
        undefined,
        undefined,
        token
      ).catch(reject)
    })
  }
}

describe('paired Setup admission', () => {
  it.each([20, 200])('keeps unrelated request capacity with %i pending drafts', async (count) => {
    const path = mkdtempSync(join(tmpdir(), 'orca-setup-admission-'))
    const runtime = new SetupHost()
    const setup = Promise.withResolvers<{ exitCode: number | null }>()
    const release = Promise.withResolvers<void>()
    const admitted = Promise.withResolvers<void>()
    let waiting = 0
    const hold = async () => {
      if (++waiting === 16) {
        admitted.resolve()
      }
      await release.promise
      return { accepted: true }
    }
    const methods = [
      ...['terminal.wait', 'agent.launch'].map((name) =>
        defineMethod({
          name,
          permission: 'workspace',
          params: z.object({}),
          handler: hold
        })
      ),
      defineOrchestrationMethod({
        name: 'orchestration.workerStart',
        permission: 'workspace',
        access: { kind: 'writes', targets: {} },
        params: z.object({}),
        handler: hold
      })
    ]
    const server = new PairedServer({
      runtime,
      userDataPath: path,
      methods: [...TERMINAL_QUERY_METHODS, ...methods]
    })
    const token = server.pair(path)
    const clients = Array.from({ length: 4 }, () => new TerminalSetupObservers())
    for (const client of clients) {
      client.setConnected('host', true)
    }
    const unsubscribe = runtime.onClientEvent((event) => {
      if (event.type === 'terminalSetupChanged') {
        for (const client of clients) {
          client.changed('host', event.status)
        }
      }
    })
    let reads = 0
    const snapshots = Promise.withResolvers<void>()
    const drafts: Promise<void>[] = []
    try {
      for (let index = 0; index < count; index += 1) {
        const id = `pty-${index}`
        runtime.bindSetup(id, setup.promise)
        drafts.push(
          clients[index % 4].wait('host', id, async () => {
            const response = await server.request(token, id, 'terminal.setupStatus')
            if (!response.ok) {
              throw new Error(response.error.code)
            }
            if (++reads === count * 2) {
              snapshots.resolve()
            }
            if (!isTerminalSetupStatus(response.result)) {
              throw new Error('invalid Setup status')
            }
            return response.result
          })
        )
      }
      await snapshots.promise
      const longRequests = Array.from({ length: 16 }, (_, index) =>
        server.request(
          token,
          `long-${index}`,
          index === 0 ? 'orchestration.workerStart' : index === 1 ? 'agent.launch' : 'terminal.wait'
        )
      )
      await Promise.race([
        admitted.promise,
        Promise.all(
          longRequests.map(async (request) => {
            const response = await request
            if (!response.ok) {
              throw new Error(JSON.stringify(response))
            }
            return response
          })
        ).then(() => {
          throw new Error('long requests ended before release')
        })
      ])
      await expect(server.request(token, 'overflow', 'terminal.wait')).resolves.toMatchObject({
        ok: false,
        error: { code: 'runtime_busy' }
      })
      setup.resolve({ exitCode: 0 })
      await Promise.all(drafts)
      expect(clients.flatMap((client) => client.pendingScopes())).toEqual([])
      release.resolve()
      await expect(Promise.all(longRequests)).resolves.toEqual(
        Array.from({ length: 16 }, () => expect.objectContaining({ ok: true }))
      )
    } finally {
      setup.resolve({ exitCode: null })
      release.resolve()
      unsubscribe()
      runtime.cleanupSubscriptionsForConnection('setup-test')
      await server.stop()
      rmSync(path, { recursive: true, force: true })
    }
  })
})
