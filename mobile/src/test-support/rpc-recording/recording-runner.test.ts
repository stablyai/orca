import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { operationModuleLoader } from './operation-module-loader'
import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import { describe, expect, it } from 'vitest'
import { captureArguments, captureValue } from './recording-values'
import { ScriptedRpcTransport } from './scripted-rpc-transport'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { readGolden, writeGolden, type GoldenRecording } from './golden-recording'
import { replyPartitions } from './reply-matrix'

describe('recording boundaries', () => {
  it('preserves omitted arguments, explicit undefined, null, order, and tagged-looking objects', () => {
    expect(captureArguments(['m'])).not.toEqual(captureArguments(['m', undefined]))
    expect(captureArguments(['m', undefined])).not.toEqual(captureArguments(['m', null]))
    expect(captureValue({ b: undefined, a: null })).toEqual(captureValue({ a: null, b: undefined }))
    expect(captureValue({ $rpc: 'undefined' })).not.toEqual(captureValue(undefined))
    expect(captureValue([1, 2])).not.toEqual(captureValue([2, 1]))
  })

  it('runs the actual stable-client projection and physical serialization', async () => {
    const clock = vitestRecordingScheduler()
    clock.start()
    const transport = new ScriptedRpcTransport()
    try {
      const result = transport.client.sendRequest(
        'worktree.ps',
        { omitted: undefined, nullable: null },
        { timeoutMs: 7 }
      )
      await clock.flush()
      expect(transport.requests[0].args).toEqual(
        captureArguments(['worktree.ps', { omitted: undefined, nullable: null }, { timeoutMs: 7 }])
      )
      expect(JSON.parse(transport.payloads[0].json)).toEqual({
        id: 'frame-1',
        deviceToken: 'recording-device',
        method: 'worktree.ps',
        params: { nullable: null, supportsWorktreeVisibilitySourceDefaults: true }
      })
      transport.complete(
        'worktree.ps#1',
        { omitted: undefined, nullable: null, supportsWorktreeVisibilitySourceDefaults: true },
        { ok: true, result: null }
      )
      await result
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('requires logical bindings plus matching params for concurrent same-method calls', async () => {
    const clock = vitestRecordingScheduler()
    clock.start()
    const transport = new ScriptedRpcTransport()
    try {
      const left = transport.client.sendRequest('files.list', { worktree: 'A' })
      const right = transport.client.sendRequest('files.list', { worktree: 'B' })
      await clock.flush()
      expect(() => transport.complete('files.list#1', { worktree: 'A' }, {})).toThrow(
        'logical binding'
      )
      expect(() => transport.bind('left', 'files.list#1', { worktree: 'B' })).toThrow(
        'params mismatch'
      )
      transport.bind('left', 'files.list#1', { worktree: 'A' })
      transport.bind('right', 'files.list#2', { worktree: 'B' })
      transport.complete('right', { worktree: 'B' }, { ok: true, result: [] })
      transport.complete('left', { worktree: 'A' }, { ok: true, result: [] })
      await Promise.all([left, right])
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('keeps the delivery marker singleton shared with loaded real operations', () => {
    const loader = operationModuleLoader(resolve(import.meta.dirname, '../../../..'))
    const marker = loader.load<typeof import('../../transport/rpc-delivery-ambiguity')>(
      'mobile/src/transport/rpc-delivery-ambiguity.ts'
    )
    expect(marker.isRpcDeliveryUnknown(markRpcDeliveryUnknown(new Error('sent')))).toBe(true)
  })

  it('records actual deadline ambiguity and leaves peers pending before their deadlines', async () => {
    const clock = vitestRecordingScheduler()
    clock.start()
    const transport = new ScriptedRpcTransport()
    try {
      void transport.client.sendRequest('short', {}, { timeoutMs: 5 }).catch(() => {})
      void transport.client.sendRequest('long', {}, { timeoutMs: 50 }).catch(() => {})
      await clock.advance(5)
      expect(transport.requests[0].settlement).toEqual({
        status: 'rejected',
        error: {
          category: 'Error',
          message: 'Request timed out: short',
          isRpcDeliveryUnknown: true
        }
      })
      expect(transport.requests[1].settlement).toEqual({ status: 'pending' })
    } finally {
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it('never writes from candidate mode and requires both recording authorizations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rpc-recording-'))
    const golden = { recording: { scenario: 'test' } } as GoldenRecording
    const previous = process.env.RPC_FOUNDATION_RECORD
    try {
      process.env.RPC_FOUNDATION_RECORD = '0'
      await expect(writeGolden(directory, golden, '--record')).rejects.toThrow('require')
      process.env.RPC_FOUNDATION_RECORD = '1'
      await expect(writeGolden(directory, golden, 'candidate')).rejects.toThrow('require')
      await writeGolden(directory, golden, '--record')
      expect(readGolden(directory, 'test')).toEqual(golden)
      expect(() => readGolden(directory, '../escape')).toThrow('Unsafe')
    } finally {
      if (previous === undefined) {
        delete process.env.RPC_FOUNDATION_RECORD
      } else {
        process.env.RPC_FOUNDATION_RECORD = previous
      }
      rmSync(directory, { recursive: true })
    }
  })

  it('keeps absent and explicit undefined replies in separate matrix partitions', () => {
    const rows = replyPartitions({ settings: {} }, [['settings']])
    const absent = rows.find((row) => row.id === 'result-absent')!
    const explicit = rows.find((row) => row.id === 'result-undefined')!
    expect(Object.hasOwn(absent.reply as object, 'result')).toBe(false)
    expect(Object.hasOwn(explicit.reply as object, 'result')).toBe(true)
  })
})
