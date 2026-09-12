import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../../persistence-test-harness'
import { PtyOwnershipTransferDestinationRuntimeRegistry } from './pty-ownership-transfer-destination-runtime'
import { persistPtyOwnershipRetirementSurface } from './pty-ownership-transfer-retirement-surface'
import {
  identity,
  preparation,
  request
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-retirement-surface-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

const binding = preparation.surfacePublication.surfaceBinding
const paneKey = `${binding.tabId}:${binding.leafId}`
function setup() {
  const store = createStore()
  const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
    runtimeId: identity.destinationRuntimeId,
    store,
    publishPostCommitOutput: vi.fn(),
    publishPostCommitOutputAcknowledged: vi.fn()
  })
  const prepared = registry.prepareDelegated(
    {
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 0,
      replayStartSeq: 1,
      surfacePublication: preparation.surfacePublication
    },
    {
      version: 1,
      proof: request(),
      endpoint: '/incumbent.sock',
      incumbentVersion: 'incumbent',
      endpointCredential: 'secret'
    }
  )
  prepared.adapter.commit({
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-06T00:00:00Z'
  })
  prepared.adapter.publish()
  const outbox = prepared.outputOutbox
  outbox.recordRetirement(identity, {
    phase: 'prepared',
    event: {
      identity,
      surfaceBinding: binding,
      destinationClaim: { generation: 1, claimId: 'retired' },
      finalOutputSeq: 0,
      exit: { verdict: 'exited', code: 0, eventId: 'exit', observedAt: '2026-09-06T00:00:00Z' }
    }
  })
  return { store, outbox, retirement: outbox.loadRetirement(identity)! }
}

it('durably removes the exact folder-workspace surface and retries without advancing topology again', () => {
  const { store, retirement, outbox } = setup()
  persistPtyOwnershipRetirementSurface(store, retirement)
  const saved = createStore().getWorkspaceSession()
  expect(saved.terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
  expect(saved.terminalPtyIncarnationsByPaneKey?.[paneKey]).toBeUndefined()
  const flush = vi.spyOn(store, 'flushOrThrow')
  persistPtyOwnershipRetirementSurface(store, retirement)
  expect(flush).toHaveBeenCalledOnce()
  expect(createStore().getWorkspaceSession()).toEqual(saved)
  expect(outbox.loadRetirement(identity)?.phase).toBe('prepared')
})

it.each([false, true])(
  'propagates uncertain flush failure and remains retryable (written=%s)',
  (written) => {
    const { store, retirement, outbox } = setup()
    const flush = store.flushOrThrow.bind(store)
    vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      if (written) {
        flush()
      }
      throw new Error('uncertain flush')
    })
    expect(() => persistPtyOwnershipRetirementSurface(store, retirement)).toThrow('uncertain flush')
    expect(outbox.loadRetirement(identity)?.phase).toBe('prepared')
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
    expect(
      createStore().getWorkspaceSession().terminalLayoutsByTabId[binding.tabId] === undefined
    ).toBe(written)
    const revision = structuredClone(store.getWorkspaceSession().terminalTopologyRevisionByRepoId)
    persistPtyOwnershipRetirementSurface(store, retirement)
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId).toEqual(revision)
    expect(store.flushOrThrow).toHaveBeenCalledTimes(2)
    expect(
      createStore().getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]
    ).toBeUndefined()
  }
)

it('preserves a replacement incarnation on the same pane', () => {
  const { store, retirement } = setup()
  const session = store.getWorkspaceSession()
  session.terminalPtyIncarnationsByPaneKey![paneKey] = 'replacement'
  store.flushOrThrow()
  const before = createStore().getWorkspaceSession()
  persistPtyOwnershipRetirementSurface(store, retirement)
  expect(createStore().getWorkspaceSession()).toEqual(before)
})

it.each([false, true])(
  'reopens and finishes cleanup after an uncertain save (written=%s)',
  (written) => {
    const { store, retirement, outbox } = setup()
    const flush = store.flushOrThrow.bind(store)
    vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      if (written) {
        flush()
      }
      throw new Error('interrupted cleanup')
    })
    expect(() => persistPtyOwnershipRetirementSurface(store, retirement)).toThrow(
      'interrupted cleanup'
    )
    const restarted = createStore()
    persistPtyOwnershipRetirementSurface(restarted, outbox.loadRetirement(identity)!)
    expect(
      createStore().getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]
    ).toBeUndefined()
    expect(outbox.loadRetirement(identity)?.phase).toBe('prepared')
  }
)

it('refuses an old PTY binding whose incarnation proof is missing', () => {
  const { store, retirement } = setup()
  delete store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey![paneKey]
  const flush = vi.spyOn(store, 'flushOrThrow')
  expect(() => persistPtyOwnershipRetirementSurface(store, retirement)).toThrow(
    'surface_unverifiable'
  )
  expect(flush).not.toHaveBeenCalled()
  expect(store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]).toBeDefined()
})

it('refuses success when the session store ignores the cleanup write', () => {
  const { store, retirement } = setup()
  vi.spyOn(store, 'setWorkspaceSession').mockImplementation(() => {})
  expect(() => persistPtyOwnershipRetirementSurface(store, retirement)).toThrow(
    'surface_unverified'
  )
})
