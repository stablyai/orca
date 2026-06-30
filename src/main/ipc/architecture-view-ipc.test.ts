import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

import {
  closeArchitectureWatchers,
  defaultArchitectureDeps,
  registerArchitectureHandlers,
  type ArchitectureIpcRegistrar
} from './architecture'
import type { ScryerEngine } from '../scryer/engine'

describe('registerArchitectureHandlers native engine migration', () => {
  afterEach(() => {
    closeArchitectureWatchers()
  })

  it('routes canonical architecture reads through readView without legacy extension state', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-read-view-'))
    const readModel = vi.fn(defaultArchitectureDeps.readModel)
    const readView = vi.fn(async () => ({
      ok: true,
      operationId: 'scryer.model.read',
      requestId: 'ipc-read-test',
      result: {
        mode: 'full',
        layer: 'committed',
        summary: { nodeCount: 2, linkCount: 1, groupCount: 1 },
        nodes: [],
        links: [],
        recommendedNextReads: [],
        model: {
          version: '0.3',
          nodes: [
            { id: 'api', kind: 'system', name: 'API', description: 'HTTP API' },
            { id: 'web', kind: 'container', name: 'Web', parentId: 'api', technology: 'React' }
          ],
          links: [{ id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' }],
          groups: [{ id: 'frontend', name: 'Frontend', memberIds: ['web'] }],
          sourceMap: { web: [{ pattern: 'src/web.ts' }] },
          boundaries: {}
        }
      }
    }))
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      readModel,
      scryerEngine: {
        executeOperation: vi.fn() as unknown as ScryerEngine['executeOperation'],
        readView: readView as unknown as ScryerEngine['readView']
      }
    })

    const model = await handlers.get('architecture:readModel')!(null, { projectPath })

    expect(readView).toHaveBeenCalledWith(
      { layer: 'committed' },
      expect.objectContaining({ transport: 'ipc', projectRoot: projectPath })
    )
    expect(readModel).not.toHaveBeenCalled()
    expect(model).toMatchObject({
      projectPath,
      nodes: [
        expect.objectContaining({ id: 'api', data: expect.objectContaining({ name: 'API' }) }),
        expect.objectContaining({
          id: 'web',
          parentId: 'api',
          data: expect.objectContaining({ kind: 'container', technology: 'React' })
        })
      ],
      edges: [expect.objectContaining({ id: 'link-web-api', source: 'web', target: 'api' })],
      groups: [expect.objectContaining({ id: 'frontend', memberIds: ['web'] })],
      sourceMap: { web: [{ pattern: 'src/web.ts' }] }
    })
    expect(model).not.toMatchObject({
      nodes: [expect.objectContaining({ id: 'legacy-node' })],
      sourceMap: { legacy: [{ pattern: 'legacy.ts' }] }
    })
  })

  it('does not fall back to legacy model reads after a cataloged engine read failure', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-read-failure-'))
    const readModel = vi.fn(defaultArchitectureDeps.readModel)
    const readView = vi.fn(async () => ({
      ok: false,
      operationId: 'scryer.model.read',
      requestId: 'ipc-read-failure-test',
      error: {
        code: 'internal_error',
        message: 'read contract failed',
        details: { reason: 'success_schema_failed' }
      }
    }))
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      readModel,
      scryerEngine: {
        executeOperation: vi.fn() as unknown as ScryerEngine['executeOperation'],
        readView: readView as unknown as ScryerEngine['readView']
      }
    })

    await expect(handlers.get('architecture:readModel')!(null, { projectPath })).rejects.toThrow(
      'read contract failed'
    )
    expect(readModel).not.toHaveBeenCalled()
  })

  it('does not create a legacy default model after an incompatible cataloged engine read', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-read-incompatible-'))
    const readModel = vi.fn(defaultArchitectureDeps.readModel)
    const readView = vi.fn(async () => ({
      ok: false,
      operationId: 'scryer.model.read',
      requestId: 'ipc-read-incompatible-test',
      error: {
        code: 'incompatible_model',
        message: 'Missing Scryer model file',
        details: { reason: 'invalid_json' }
      }
    }))
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      readModel,
      scryerEngine: {
        executeOperation: vi.fn() as unknown as ScryerEngine['executeOperation'],
        readView: readView as unknown as ScryerEngine['readView']
      }
    })

    await expect(
      handlers.get('architecture:readModel')!(null, { projectPath, modelName: 'model' })
    ).rejects.toThrow('Missing Scryer model file')
    expect(readModel).not.toHaveBeenCalled()
  })

  it('retries canonical model document reads while the Native Scryer Engine lock is busy', async () => {
    vi.useFakeTimers()
    try {
      handlers.clear()
      const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-read-lock-retry-'))
      const readView = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          operationId: 'scryer.model.read',
          requestId: 'ipc-read-lock-busy',
          error: {
            code: 'lock_busy',
            message: 'Scryer model lock is already held',
            details: { lockPath: join(projectPath, '.scryer', '.lock') },
            retryable: true
          }
        })
        .mockResolvedValueOnce({
          ok: true,
          operationId: 'scryer.model.read',
          requestId: 'ipc-read-lock-recovered',
          result: {
            mode: 'full',
            layer: 'committed',
            summary: { nodeCount: 1, linkCount: 0, groupCount: 0 },
            nodes: [],
            links: [],
            recommendedNextReads: [],
            model: {
              version: '0.3',
              nodes: [{ id: 'api', kind: 'system', name: 'API' }],
              links: [],
              groups: [],
              sourceMap: {},
              boundaries: {}
            }
          }
        })
      const registrar: ArchitectureIpcRegistrar = {
        handle: (channel, handler) => {
          handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
        }
      }
      registerArchitectureHandlers(registrar, {
        ...defaultArchitectureDeps,
        readModel: vi.fn(async () => ({
          projectPath,
          nodes: [],
          edges: [],
          sourceMap: {}
        })),
        scryerEngine: {
          executeOperation: vi.fn() as unknown as ScryerEngine['executeOperation'],
          readView: readView as unknown as ScryerEngine['readView']
        }
      })

      const readPromise = handlers.get('architecture:readModelDocument')!(null, { projectPath })
      await vi.advanceTimersByTimeAsync(25)

      await expect(readPromise).resolves.toMatchObject({
        revision: 'ipc-read-lock-recovered',
        model: { nodes: [expect.objectContaining({ id: 'api' })] }
      })
      expect(readView).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes canonical node patches through scryer.node.update before adapting the planned model', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-node-update-seam-'))
    const patchNodeData = vi.fn(defaultArchitectureDeps.patchNodeData)
    const send = vi.fn()
    const executeOperation = vi.fn(async () => ({
      ok: true,
      operationId: 'scryer.node.update',
      requestId: 'req-engine-patch',
      result: { updatedCount: 1 }
    }))
    const readView = vi.fn(async () => ({
      ok: true,
      operationId: 'scryer.model.read',
      requestId: 'req-engine-read',
      result: {
        mode: 'full',
        layer: 'plan',
        summary: { nodeCount: 1, linkCount: 0, groupCount: 0 },
        nodes: [],
        links: [],
        recommendedNextReads: [],
        model: {
          version: '0.3',
          nodes: [{ id: 'api', kind: 'system', name: 'Public API' }],
          links: [],
          groups: [],
          sourceMap: {},
          boundaries: {}
        }
      }
    }))
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      patchNodeData,
      scryerEngine: {
        executeOperation: executeOperation as unknown as ScryerEngine['executeOperation'],
        readView: readView as unknown as ScryerEngine['readView']
      }
    })

    const result = await handlers.get('architecture:patchNodeData')!(
      { sender: { send } },
      { projectPath, modelName: 'model', nodeId: 'api', patch: { name: 'Public API' } }
    )

    expect(executeOperation).toHaveBeenCalledWith(
      'scryer.node.update',
      { nodes: [{ node_id: 'api', name: 'Public API' }] },
      expect.objectContaining({ transport: 'ipc', projectRoot: projectPath })
    )
    expect(readView).toHaveBeenCalledWith(
      { layer: 'plan' },
      expect.objectContaining({ transport: 'ipc', projectRoot: projectPath })
    )
    expect(patchNodeData).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'planned.scry'
    })
    expect(result).toMatchObject({
      revision: 'req-engine-patch',
      model: {
        nodes: [
          expect.objectContaining({
            id: 'api',
            data: expect.objectContaining({ name: 'Public API' })
          })
        ]
      }
    })
  })

  it('does not fall back to legacy node patching after a cataloged engine refresh failure', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-patch-read-failure-'))
    const patchNodeData = vi.fn(defaultArchitectureDeps.patchNodeData)
    const executeOperation = vi.fn(async () => ({
      ok: true,
      operationId: 'scryer.node.update',
      requestId: 'req-engine-patch-failure',
      result: { updatedCount: 1 }
    }))
    const readView = vi.fn(async () => ({
      ok: false,
      operationId: 'scryer.model.read',
      requestId: 'req-engine-refresh-failure',
      error: {
        code: 'internal_error',
        message: 'refresh contract failed',
        details: { reason: 'success_schema_failed' }
      }
    }))
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      patchNodeData,
      scryerEngine: {
        executeOperation: executeOperation as unknown as ScryerEngine['executeOperation'],
        readView: readView as unknown as ScryerEngine['readView']
      }
    })

    await expect(
      handlers.get('architecture:patchNodeData')!(
        { sender: { send: vi.fn() } },
        { projectPath, modelName: 'model', nodeId: 'api', patch: { name: 'Public API' } }
      )
    ).rejects.toThrow('refresh contract failed')
    expect(patchNodeData).not.toHaveBeenCalled()
  })

  it('does not fall back to legacy node patching after an incompatible cataloged engine write', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-patch-incompatible-'))
    const patchNodeData = vi.fn(defaultArchitectureDeps.patchNodeData)
    const executeOperation = vi.fn(async () => ({
      ok: false,
      operationId: 'scryer.node.update',
      requestId: 'req-engine-patch-incompatible',
      error: {
        code: 'incompatible_model',
        message: 'Model file uses an incompatible schema',
        details: { reason: 'unsupported_version' }
      }
    }))
    const readView = vi.fn()
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      patchNodeData,
      scryerEngine: {
        executeOperation: executeOperation as unknown as ScryerEngine['executeOperation'],
        readView: readView as unknown as ScryerEngine['readView']
      }
    })

    await expect(
      handlers.get('architecture:patchNodeData')!(
        { sender: { send: vi.fn() } },
        { projectPath, modelName: 'model', nodeId: 'api', patch: { name: 'Public API' } }
      )
    ).rejects.toThrow('Model file uses an incompatible schema')
    expect(patchNodeData).not.toHaveBeenCalled()
    expect(readView).not.toHaveBeenCalled()
  })

  it('does not synthesize legacy drift results after incompatible cataloged engine results', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-drift-incompatible-'))
    const executeOperation = vi.fn(async (operationId: string) => ({
      ok: false,
      operationId,
      requestId: `req-${operationId}`,
      error: {
        code: 'incompatible_model',
        message: `${operationId} requires a Scryer 0.3 model`,
        details: { reason: 'missing_version' }
      }
    }))
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      scryerEngine: {
        executeOperation: executeOperation as unknown as ScryerEngine['executeOperation'],
        readView: vi.fn() as unknown as ScryerEngine['readView']
      }
    })

    await expect(handlers.get('architecture:checkDrift')!(null, { projectPath })).rejects.toThrow(
      'scryer.drift.get requires a Scryer 0.3 model'
    )
    await expect(
      handlers.get('architecture:markSynced')!(null, { projectPath })
    ).resolves.toMatchObject({
      ok: false,
      operationId: 'scryer.drift.reconcile',
      error: { code: 'incompatible_model' }
    })
  })

  it('prepares default-model AI prompts through readView instead of legacy model reads', async () => {
    handlers.clear()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-prompt-read-view-'))
    const readModel = vi.fn(defaultArchitectureDeps.readModel)
    const readView = vi.fn(async () => ({
      ok: true,
      operationId: 'scryer.model.read',
      requestId: 'ipc-prompt-read-view',
      result: {
        mode: 'full',
        layer: 'plan',
        summary: { nodeCount: 2, linkCount: 0, groupCount: 0 },
        nodes: [],
        links: [],
        recommendedNextReads: [],
        model: {
          version: '0.3',
          nodes: [
            { id: 'api', kind: 'system', name: 'API', description: 'HTTP API' },
            {
              id: 'handler',
              kind: 'component',
              name: 'Handler',
              description: 'Request handler',
              parentId: 'api'
            }
          ],
          links: [],
          groups: [],
          sourceMap: {},
          boundaries: {}
        }
      }
    }))
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      readModel,
      scryerEngine: {
        executeOperation: vi.fn() as unknown as ScryerEngine['executeOperation'],
        readView: readView as unknown as ScryerEngine['readView']
      }
    })

    await expect(
      handlers.get('architecture:prepareNodeFillPrompt')!(null, {
        projectPath,
        modelName: 'model',
        nodeId: 'handler'
      })
    ).resolves.toMatchObject({
      prompt: expect.stringContaining('Fill out the internals of "Handler"')
    })
    await expect(
      handlers.get('architecture:prepareAdvisorPrompt')!(null, { projectPath, modelName: 'model' })
    ).resolves.toMatchObject({
      prompt: expect.stringContaining('Review the C4 architecture model "model"')
    })

    expect(readView).toHaveBeenCalledTimes(2)
    expect(readView).toHaveBeenNthCalledWith(
      1,
      { layer: 'plan' },
      expect.objectContaining({ transport: 'ipc', projectRoot: projectPath })
    )
    expect(readView).toHaveBeenNthCalledWith(
      2,
      { layer: 'plan' },
      expect.objectContaining({ transport: 'ipc', projectRoot: projectPath })
    )
    expect(readModel).not.toHaveBeenCalled()
  })

  it('exposes a seam spy for migrated IPC calls through the Native Scryer Engine', async () => {
    handlers.clear()
    const executeOperation = vi.fn(
      async (operationId: string, _input: unknown, context: unknown) => ({
        ok: true,
        operationId,
        requestId: 'ipc-spy',
        result:
          operationId === 'scryer.drift.reconcile'
            ? { reconciledAt: '2026-06-25T00:00:00.000Z' }
            : operationId === 'scryer.drift.get'
              ? { clean: true, scopes: [], baseline: {}, recommendedNextReads: [] }
              : { updatedCount: 1 },
        context
      })
    )
    const readView = vi.fn()
    const registrar: ArchitectureIpcRegistrar = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (_event: unknown, args: unknown) => Promise<unknown>)
      }
    }
    registerArchitectureHandlers(registrar, {
      ...defaultArchitectureDeps,
      scryerEngine: {
        executeOperation: executeOperation as unknown as ScryerEngine['executeOperation'],
        readView: readView as unknown as ScryerEngine['readView']
      }
    })
    const send = vi.fn()
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-ipc-seam-spy-'))

    await handlers.get('architecture:checkDrift')!(null, { projectPath })
    await handlers.get('architecture:markSynced')!(null, { projectPath })
    await handlers.get('architecture:executeScryerOperation')!(
      { sender: { send } },
      {
        projectPath,
        operationId: 'scryer.node.update',
        input: { nodes: [{ node_id: 'api', name: 'API' }] },
        requestId: 'req-node-update',
        leaseToken: 'renderer-token'
      }
    )

    expect(executeOperation).toHaveBeenNthCalledWith(
      1,
      'scryer.drift.get',
      {},
      expect.objectContaining({ transport: 'ipc', projectRoot: projectPath })
    )
    expect(executeOperation).toHaveBeenNthCalledWith(
      2,
      'scryer.drift.reconcile',
      {},
      expect.objectContaining({ transport: 'ipc', projectRoot: projectPath })
    )
    expect(executeOperation).toHaveBeenNthCalledWith(
      3,
      'scryer.node.update',
      { nodes: [{ node_id: 'api', name: 'API' }] },
      expect.objectContaining({ requestId: 'req-node-update', transport: 'ipc' })
    )
    expect(executeOperation.mock.calls[2]?.[2]).not.toHaveProperty('leaseToken')
    expect(send).toHaveBeenCalledWith('architecture:modelChanged', {
      projectPath,
      fileName: 'planned.scry'
    })
    expect(readView).not.toHaveBeenCalled()
  })
})
