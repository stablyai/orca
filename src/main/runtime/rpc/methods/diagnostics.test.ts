import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES } from '../../../../shared/diagnostic-bundle-export-types'
import { DIAGNOSTICS_METHODS } from './diagnostics'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('diagnostics RPC methods', () => {
  it('collects the runtime memory snapshot', async () => {
    const snapshot = {
      app: {
        cpu: 1,
        memory: 1024,
        main: { cpu: 1, memory: 512 },
        renderer: { cpu: 0, memory: 256 },
        other: { cpu: 0, memory: 256 },
        history: [1024]
      },
      worktrees: [],
      host: {
        totalMemory: 4096,
        freeMemory: 1024,
        usedMemory: 3072,
        memoryUsagePercent: 75,
        cpuCoreCount: 8,
        loadAverage1m: 1.25
      },
      totalCpu: 1,
      totalMemory: 1024,
      collectedAt: 123
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getMemorySnapshot: vi.fn().mockResolvedValue(snapshot)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: DIAGNOSTICS_METHODS })

    const response = await dispatcher.dispatch(makeRequest('diagnostics.memory'))

    expect(runtime.getMemorySnapshot).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({
      ok: true,
      result: snapshot
    })
  })

  it('exports a diagnostics bundle through the runtime', async () => {
    const bundle = {
      bundleId: 'bundle-1',
      outputPath:
        'C:\\Users\\example\\AppData\\Local\\Orca\\logs\\diagnostics\\orca-diagnostics.zip',
      bytes: 1234,
      lookbackMinutes: 120,
      includedCategories: ['app'],
      skippedCategories: [],
      errorCategories: [],
      fileCount: 2
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createDiagnosticBundle: vi.fn().mockResolvedValue(bundle)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: DIAGNOSTICS_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('diagnostics.bundle', {
        output: 'orca-diagnostics.zip',
        lookbackMinutes: 120,
        include: ['app'],
        exclude: ['native-minidumps'],
        open: true
      })
    )

    expect(runtime.createDiagnosticBundle).toHaveBeenCalledWith({
      output: 'orca-diagnostics.zip',
      lookbackMinutes: 120,
      include: ['app'],
      exclude: ['native-minidumps'],
      open: true
    })
    expect(response).toMatchObject({
      ok: true,
      result: bundle
    })
  })

  it('rejects unknown diagnostic bundle categories', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createDiagnosticBundle: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: DIAGNOSTICS_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('diagnostics.bundle', { include: ['not-a-category'] })
    )

    expect(runtime.createDiagnosticBundle).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument'
      }
    })
  })

  it('rejects diagnostics bundle lookbacks beyond the shared cap', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createDiagnosticBundle: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: DIAGNOSTICS_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('diagnostics.bundle', {
        lookbackMinutes: MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES + 1
      })
    )

    expect(runtime.createDiagnosticBundle).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument'
      }
    })
  })

  it('accepts diagnostics bundle lookbacks at the shared cap', async () => {
    const bundle = {
      bundleId: 'bundle-1',
      outputPath:
        'C:\\Users\\example\\AppData\\Local\\Orca\\logs\\diagnostics\\orca-diagnostics.zip',
      bytes: 1234,
      lookbackMinutes: MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES,
      includedCategories: ['app'],
      skippedCategories: [],
      errorCategories: [],
      fileCount: 2
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createDiagnosticBundle: vi.fn().mockResolvedValue(bundle)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: DIAGNOSTICS_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('diagnostics.bundle', {
        lookbackMinutes: MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES
      })
    )

    expect(runtime.createDiagnosticBundle).toHaveBeenCalledWith({
      lookbackMinutes: MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES
    })
    expect(response).toMatchObject({
      ok: true,
      result: bundle
    })
  })

  it('rejects diagnostics bundle output paths outside the diagnostics directory', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createDiagnosticBundle: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: DIAGNOSTICS_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('diagnostics.bundle', {
        output: '../orca-diagnostics.zip'
      })
    )

    expect(runtime.createDiagnosticBundle).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument'
      }
    })
  })
})
