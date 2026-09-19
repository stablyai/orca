import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandler } from './pty-handler'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD
} from '../shared/pty-ownership-transfer-destination-claim'
import {
  beginPtyHandlerTest,
  endPtyHandlerTest,
  type MockDispatcher
} from './pty-handler-test-harness'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  makeDelegatedRelay,
  preparation,
  request,
  context
} from './relay-pty-ownership-transfer-delegation-test-fixture'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))
vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

describe('PTY handler with durable ownership-transfer output retries', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-output-retry-'))
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })
  afterEach(async () => {
    handler.setOwnershipTransferOutputObserver(null)
    await endPtyHandlerTest(handler, originalPlatform)
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    { failurePoint: 'before', failures: 1 },
    { failurePoint: 'after', failures: 1 },
    { failurePoint: 'before', failures: 3 },
    { failurePoint: 'after', failures: 3 },
    { failurePoint: 'before', failures: 3, exitBeforeRecovery: true },
    { failurePoint: 'after', failures: 3, exitBeforeRecovery: true },
    { failurePoint: 'before', failures: 3, exitBeforeRecovery: 'reap' },
    { failurePoint: 'after', failures: 3, exitBeforeRecovery: 'reap' },
    { failurePoint: 'before', failures: 1, ordinary: true },
    { failurePoint: 'after', failures: 1, ordinary: true },
    { failurePoint: 'before', failures: 0, retention: true },
    { failurePoint: 'before', failures: 1, retention: true, oversized: true },
    { failurePoint: 'after', failures: 1, retention: true, oversized: true }
  ])(
    'preserves order across $failures observer save failures $failurePoint rename',
    async ({ failurePoint, failures, exitBeforeRecovery, ordinary, retention, oversized }) => {
      let emit: ((data: string) => void) | undefined
      let exit: ((event: { exitCode: number }) => void) | undefined
      mockPtySpawn.mockReturnValueOnce({
        ...mockPtyInstance,
        onData: vi.fn((callback: (data: string) => void) => {
          emit = callback
        }),
        onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
          exit = callback
        })
      })
      const spawned = (await dispatcher.callRequest('pty.spawn', {})) as {
        id: string
        incarnationId: string
      }
      const store = new RelayPtyOwnershipTransferFileStore(directory)
      let failuresRemaining = 0
      let exitFailuresRemaining = exitBeforeRecovery ? 2 : 0
      let desktopConnected = true
      const source = {
        terminalId: spawned.id,
        incarnationId: spawned.incarnationId,
        ownerLease: 'desktop-lease',
        sourceOwnerGeneration: 8
      }
      const adapter = makeDelegatedRelay(
        {
          loadAll: () => store.loadAll(),
          remove: (id) => store.remove(id),
          save: (record) => {
            const fail = failuresRemaining > 0 || (record.exit && exitFailuresRemaining > 0)
            if (failuresRemaining > 0) {
              failuresRemaining--
            } else if (record.exit && exitFailuresRemaining > 0) {
              exitFailuresRemaining--
            }
            if (!fail || failurePoint === 'after') {
              store.save(record)
            }
            if (fail) {
              throw new Error('injected journal failure')
            }
          }
        },
        {
          ...(retention ? { enableDestinationOutputRetention: true, replayBytes: 7 } : {}),
          resolveSource: () => (desktopConnected ? source : null),
          hasPendingSourceOutput: (id) => handler.hasPendingOwnershipTransferOutput(id),
          resolveTerminalIncarnation: (id) =>
            handler.resolveOwnershipTransferTerminal(id)?.incarnationId ?? null,
          setInputFenced: (id, fenced) => handler.setOwnershipTransferInputFenced(id, fenced)
        }
      )
      handler.setOwnershipTransferOutputObserver(adapter)
      adapter.prepare({
        ...preparation,
        ...source,
        ...(ordinary ? { destinationDelegation: undefined } : {}),
        surfacePublication: {
          ...preparation.surfacePublication,
          surfaceBinding: { ...preparation.surfacePublication.surfaceBinding, ptyId: spawned.id }
        }
      })
      if (retention) {
        adapter.claimDestination({ ...request(), ...source }, context())
      }
      failuresRemaining = failures
      desktopConnected = ordinary === true
      const firstData = oversized ? '😀123' : 'first\n'
      const secondData = oversized ? '😀456' : 'second\n'
      if (oversized) {
        emit!(firstData + secondData)
      } else {
        emit!(firstData)
        emit!(secondData)
      }
      if (retention) {
        const methods = new Map<string, MethodHandler>()
        adapter.register({
          onRequest: (method: string, callback: MethodHandler) => methods.set(method, callback)
        } as unknown as RelayDispatcher)
        vi.advanceTimersByTime(32)
        expect(mockPtyInstance.pause).toHaveBeenCalled()
        expect(mockPtyInstance.resume).not.toHaveBeenCalled()
        expect(handler.hasPendingOwnershipTransferOutput(spawned.id)).toBe(true)
        expect(store.loadAll()[0].history.frames).toEqual([{ seq: 1, data: firstData }])
        const proof = {
          ...request(),
          ...source,
          destinationClaim: { generation: 1, claimId: 'claim-1' },
          afterSeq: 0
        }
        await methods.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD)!(proof, context())
        await methods.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD)!(
          { ...proof, afterSeq: 1 },
          context()
        )
      }
      const commit = (acceptedSourceEndSeq: number) =>
        adapter.commit({
          ...preparation,
          ...source,
          acceptedSourceEndSeq,
          receipt: {
            bridgeId: preparation.bridgeId,
            receiptId: 'commit-receipt',
            acceptedSourceEndSeq,
            committedAt: '2026-09-06T00:00:00.000Z'
          }
        })
      if (ordinary) {
        expect(handler.hasPendingOwnershipTransferOutput(spawned.id)).toBe(true)
        expect(() => commit(0)).toThrow('awaiting durable observation')
        expect(store.loadAll()[0].phase).toBe('prepared')
      }
      if (exitBeforeRecovery === 'reap') {
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        })
        try {
          await expect(dispatcher.callRequest('pty.attach', { id: spawned.id })).rejects.toThrow()
        } finally {
          kill.mockRestore()
        }
      } else if (exitBeforeRecovery) {
        exit!({ exitCode: 0 })
      }
      vi.advanceTimersByTime(128)
      const frames = store.loadAll()[0].history.frames
      expect(frames.map((frame) => frame.data).join('')).toBe(
        retention ? secondData : firstData + secondData
      )
      expect(frames.map((frame) => frame.seq)).toEqual(retention ? [2] : [1, 2])
      if (retention) {
        expect(handler.hasPendingOwnershipTransferOutput(spawned.id)).toBe(false)
        expect(mockPtyInstance.resume).toHaveBeenCalledTimes(1)
      }
      const published = dispatcher.notify.mock.calls
        .filter(([method]) => method === 'pty.data')
        .map(([, params]) => params?.data)
        .join('')
      expect(published).toBe(firstData + secondData)
      if (ordinary) {
        expect(handler.hasPendingOwnershipTransferOutput(spawned.id)).toBe(false)
        expect(() => commit(0)).toThrow('source ends at 2')
        expect(commit(2)).toMatchObject({ phase: 'committed' })
      }
      if (exitBeforeRecovery) {
        expect(store.loadAll()[0].exit).toMatchObject({
          verdict: 'exited',
          code: exitBeforeRecovery === 'reap' ? -1 : 0
        })
        const events = dispatcher.notify.mock.calls
          .map(([method]) => method)
          .filter((method) => method === 'pty.data' || method === 'pty.exit')
        expect(events.at(-1)).toBe('pty.exit')
        expect(events.filter((method) => method === 'pty.exit')).toHaveLength(1)
      }
      expect(mockPtyInstance.pause).toHaveBeenCalled()
      expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    }
  )
})
