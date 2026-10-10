import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CryptoModule from 'node:crypto'
import type * as SnapshotModule from '../shared/process-table-snapshot-reader'
import { RelayDispatcher } from '../wsl-guest/dispatcher'
import {
  encodeJsonRpcFrame,
  parseJsonRpcMessage,
  type JsonRpcResponse
} from '../wsl-guest/protocol'
import { PtyHandler } from './pty-handler'
import { ClaimedAgentPtyOwnerRegistry } from '../shared/claimed-agent-pty-owner'
import {
  isAgentSessionClaimedSpawnResult,
  isAgentSessionOwnerBinding,
  type AgentSessionOwnerBinding
} from '../shared/agent-session-host-authority'
import * as ptyShell from './pty-shell-utils'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), snapshots: vi.fn(), uuid: 0 }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>()
  return {
    ...actual,
    randomUUID: () => `00000000-0000-4000-8000-${String(++mocks.uuid).padStart(12, '0')}`
  }
})
vi.mock('node-pty', () => ({ spawn: mocks.spawn }))
vi.mock('../shared/process-table-snapshot-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotModule>()
  return { ...actual, getStrictProcessTableSnapshotWithAge: mocks.snapshots }
})
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

type InventoryRow = {
  id: string
  incarnationId: string
  agentSessionOwners?: AgentSessionOwnerBinding[]
}

function inventoryRows(value: unknown): InventoryRow[] {
  if (!Array.isArray(value)) {
    throw new Error('Inventory result must be an array')
  }
  return value.map((row: unknown) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('id' in row) ||
      typeof row.id !== 'string' ||
      !('incarnationId' in row) ||
      typeof row.incarnationId !== 'string'
    ) {
      throw new Error('Inventory row identity is missing')
    }
    const owners = 'agentSessionOwners' in row ? row.agentSessionOwners : undefined
    if (
      owners !== undefined &&
      (!Array.isArray(owners) || !owners.every(isAgentSessionOwnerBinding))
    ) {
      throw new Error('Inventory owners are malformed')
    }
    return {
      id: row.id,
      incarnationId: row.incarnationId,
      ...(owners ? { agentSessionOwners: owners } : {})
    }
  })
}

describe('relay owner inventory clone budget', () => {
  let dispatcher: RelayDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let requestId = 0
  const frames: Buffer[] = []

  async function response(method: string, params: Record<string, unknown> = {}) {
    const id = ++requestId
    const before = frames.length
    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0))
    for (let turn = 0; turn < 50 && frames.length === before; turn++) {
      await Promise.resolve()
    }
    expect(frames).toHaveLength(before + 1)
    const frame = frames[before]
    const message = parseJsonRpcMessage(frame.subarray(13))
    return { message, frame }
  }

  async function request(method: string, params: Record<string, unknown> = {}) {
    const { message, frame } = await response(method, params)
    const id = requestId
    if (!('id' in message) || message.id !== id || 'method' in message || !('result' in message)) {
      throw new Error(`Unexpected RPC response: ${JSON.stringify(message)}`)
    }
    return { result: message.result, frame }
  }

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    vi.useFakeTimers()
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    vi.spyOn(ptyShell, 'isProcessAlive').mockReturnValue(true)
    mocks.snapshots.mockReset().mockResolvedValue({ rows: [], capturedAgeMs: 0 })
    mocks.uuid = 0
    mocks.spawn.mockReset().mockImplementation(() => ({
      pid: process.pid,
      process: 'zsh',
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn()
    }))
    requestId = 0
    frames.length = 0
    dispatcher = new RelayDispatcher((frame) => {
      frames.push(Buffer.from(frame))
      return true
    })
    handler = new PtyHandler(dispatcher, undefined, 'owner-budget')
  })

  afterEach(async () => {
    await handler.dispose({ waitForPhysicalExit: false })
    dispatcher.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it.each([false, true, undefined])(
    'samples the complete frame clock before cloning, evidence=%s',
    async (includeForegroundProcessEvidence) => {
      const spawned = await request('pty.spawn', {
        cwd: process.cwd(),
        env: { ORCA_PANE_KEY: 'clock-pane' },
        agentSessionEnsure: {
          claim: {
            digestVersion: 1,
            keyId: 'clock-key',
            identityDigest: 'a'.repeat(43),
            worktreeScopeDigest: 'b'.repeat(43),
            agent: 'codex'
          },
          surface: {
            worktreeId: 'clock-folder',
            tabId: '11111111-1111-4111-8111-111111111111',
            leafId: '22222222-2222-4222-8222-222222222222',
            terminalHandle: 'term_clock'
          }
        }
      })
      const identity = inventoryRows([spawned.result])[0]
      if (
        typeof spawned.result !== 'object' ||
        spawned.result === null ||
        !('agentSessionEnsure' in spawned.result) ||
        !isAgentSessionClaimedSpawnResult(spawned.result.agentSessionEnsure)
      ) {
        throw new Error('Claimed spawn receipt is missing')
      }
      let now = 1_000_017
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      const originalList = ClaimedAgentPtyOwnerRegistry.prototype.listForPty
      vi.spyOn(ClaimedAgentPtyOwnerRegistry.prototype, 'listForPty').mockImplementation(function (
        this: ClaimedAgentPtyOwnerRegistry,
        id: string
      ) {
        const owners = originalList.call(this, id)
        now += 20
        return owners
      })
      for (let iteration = 0; iteration < 2; iteration++) {
        now = 1_000_017 + iteration * 100
        const receipt = await request(
          'pty.listProcesses',
          includeForegroundProcessEvidence === undefined ? {} : { includeForegroundProcessEvidence }
        )
        const full = [
          {
            id: identity.id,
            incarnationId: identity.incarnationId,
            cwd: process.cwd(),
            title: 'zsh',
            hostAgeMs: 17 + iteration * 100,
            paneBound: true,
            ...(includeForegroundProcessEvidence !== false
              ? {
                  foregroundProcessEvidence: {
                    authorityGeneration: 'owner-budget',
                    observationEpoch: iteration + 1,
                    capturedAgeMs: 0,
                    verdict: 'unverifiable',
                    reason: 'root_missing'
                  }
                }
              : {}),
            agentSessionOwners: [spawned.result.agentSessionEnsure.owner]
          }
        ]
        expect(receipt.result).toEqual(full)
        expect(
          receipt.frame.equals(
            encodeJsonRpcFrame(
              { jsonrpc: '2.0', id: requestId, result: full },
              requestId,
              requestId
            )
          )
        ).toBe(true)
      }
    }
  )

  it('publishes the clock error before attempting an owner clone', async () => {
    await request('pty.spawn', { cwd: process.cwd() })
    const list = vi
      .spyOn(ClaimedAgentPtyOwnerRegistry.prototype, 'listForPty')
      .mockImplementation(() => {
        throw new Error('owner-clone-failed')
      })
    // Isolate the age read after the decoder, receive and inventory clock stamps.
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(1_000_000)
      .mockReturnValueOnce(1_000_000)
      .mockReturnValueOnce(1_000_000)
      .mockReturnValueOnce(1_000_000)
      .mockImplementationOnce(() => {
        throw new Error('host-clock-failed')
      })
    try {
      const receipt = await response('pty.listProcesses', {
        includeForegroundProcessEvidence: false
      })
      const expected: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: 'host-clock-failed' }
      }
      expect(receipt.message).toEqual(expected)
      expect(receipt.frame.equals(encodeJsonRpcFrame(expected, requestId, requestId))).toBe(true)
      expect(list).not.toHaveBeenCalled()
    } finally {
      clock.mockReturnValue(1_000_000)
    }
  })

  it.each([false, true, undefined])(
    'keeps complete RPC frames and fresh owners, evidence=%s',
    async (includeForegroundProcessEvidence) => {
      const withEvidence = includeForegroundProcessEvidence !== false
      const expected: Record<string, unknown>[] = []
      const ensure = vi.spyOn(ClaimedAgentPtyOwnerRegistry.prototype, 'ensure')
      let firstOwner: AgentSessionOwnerBinding | null = null
      const ownedCount = 8
      const plainCount = 3
      for (let index = 0; index < ownedCount + plainCount; index++) {
        const claim = {
          digestVersion: 1,
          keyId: `key${index}`,
          identityDigest: 'a'.repeat(43),
          worktreeScopeDigest: 'b'.repeat(43),
          agent: 'codex'
        }
        const surface = {
          worktreeId: `folder${index}`,
          tabId: '11111111-1111-4111-8111-111111111111',
          leafId: '22222222-2222-4222-8222-222222222222',
          terminalHandle: `term_owner${index}`
        }
        const spawned = await request('pty.spawn', {
          cwd: process.cwd(),
          env: { ORCA_PANE_KEY: `pane${index}` },
          ...(index < ownedCount ? { agentSessionEnsure: { claim, surface } } : {})
        })
        const identity = inventoryRows([spawned.result])[0]
        let owner: AgentSessionOwnerBinding | null = null
        if (index < ownedCount) {
          if (
            typeof spawned.result !== 'object' ||
            spawned.result === null ||
            !('agentSessionEnsure' in spawned.result) ||
            !isAgentSessionClaimedSpawnResult(spawned.result.agentSessionEnsure)
          ) {
            throw new Error('Claimed spawn receipt is missing')
          }
          owner = spawned.result.agentSessionEnsure.owner
          firstOwner ??= owner
        }
        expected.push({
          id: identity.id,
          incarnationId: identity.incarnationId,
          cwd: process.cwd(),
          title: 'zsh',
          hostAgeMs: 0,
          paneBound: true,
          ...(owner ? { agentSessionOwners: [owner] } : {})
        })
      }
      const registry = ensure.mock.contexts[0]
      if (!(registry instanceof ClaimedAgentPtyOwnerRegistry) || !firstOwner) {
        throw new Error('Actual claimed registry was not used')
      }
      const secondOwner: AgentSessionOwnerBinding = {
        ...firstOwner,
        claim: { ...firstOwner.claim, keyId: 'second-owner' },
        surface: { ...firstOwner.surface, terminalHandle: 'term_second' },
        generation: 'second-generation'
      }
      registry.register(secondOwner)
      expected[0].agentSessionOwners = [firstOwner, secondOwner]
      const list = vi.spyOn(ClaimedAgentPtyOwnerRegistry.prototype, 'listForPty')
      let previous: InventoryRow[] | null = null
      let previousClone: AgentSessionOwnerBinding[] | null = null
      for (let iteration = 0; iteration < 10; iteration++) {
        const firstCloneIndex = list.mock.results.length
        const response = await request(
          'pty.listProcesses',
          includeForegroundProcessEvidence === undefined ? {} : { includeForegroundProcessEvidence }
        )
        const full = expected.map(({ agentSessionOwners, ...row }) => ({
          ...row,
          ...(withEvidence
            ? {
                foregroundProcessEvidence: {
                  authorityGeneration: 'owner-budget',
                  observationEpoch: iteration + 1,
                  capturedAgeMs: 0,
                  verdict: 'unverifiable',
                  reason: 'root_missing'
                }
              }
            : {}),
          ...(agentSessionOwners ? { agentSessionOwners } : {})
        }))
        expect(response.result).toEqual(full)
        const expectedFrame = encodeJsonRpcFrame(
          { jsonrpc: '2.0', id: requestId, result: full },
          requestId,
          requestId
        )
        expect(response.frame.equals(expectedFrame)).toBe(true)
        const rows = inventoryRows(response.result)
        const firstClone: unknown = list.mock.results[firstCloneIndex].value
        if (!Array.isArray(firstClone) || !firstClone.every(isAgentSessionOwnerBinding)) {
          throw new Error('Actual registry clone is malformed')
        }
        if (previousClone) {
          expect(firstClone).not.toBe(previousClone)
          expect(firstClone[0]).not.toBe(previousClone[0])
          expect(firstClone[0].claim).not.toBe(previousClone[0].claim)
          expect(firstClone[0].surface).not.toBe(previousClone[0].surface)
        }
        if (previous) {
          expect(rows[0].agentSessionOwners).not.toBe(previous[0].agentSessionOwners)
          expect(rows[0].agentSessionOwners?.[0]).not.toBe(previous[0].agentSessionOwners?.[0])
          expect(rows[0].agentSessionOwners?.[0].claim).not.toBe(
            previous[0].agentSessionOwners?.[0].claim
          )
          expect(rows[0].agentSessionOwners?.[0].surface).not.toBe(
            previous[0].agentSessionOwners?.[0].surface
          )
        }
        const owner = rows[0].agentSessionOwners?.[0]
        if (!owner) {
          throw new Error('Expected first owner')
        }
        if (iteration === 4) {
          registry.release(secondOwner.ptyId, secondOwner.generation)
          expected[0].agentSessionOwners = [firstOwner]
        }
        owner.claim.keyId = 'mutated-client-copy'
        owner.surface.terminalHandle = 'term_mutated'
        firstClone[0].claim.keyId = 'mutated-published-clone'
        firstClone[0].surface.terminalHandle = 'term_mutated_clone'
        previousClone = firstClone
        previous = rows
      }
      expect(mocks.snapshots).toHaveBeenCalledTimes(withEvidence ? 10 : 0)
      const copiedOwners = list.mock.results.reduce((count, result) => {
        const owners: unknown = result.value
        if (!Array.isArray(owners) || !owners.every(isAgentSessionOwnerBinding)) {
          throw new Error('Actual registry clone is malformed')
        }
        return count + owners.length
      }, 0)
      expect(copiedOwners).toBe(85)
      expect(list).toHaveBeenCalledTimes((ownedCount + plainCount) * 10)
    }
  )
})
