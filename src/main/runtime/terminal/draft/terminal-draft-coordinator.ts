import type {
  TerminalDraftBeginResult,
  TerminalDraftClient,
  TerminalDraftHolder,
  TerminalDraftSaveResult,
  TerminalDraftSubmitResult
} from '../../../../shared/terminal-draft-contract'
import type { PiDraftBridgePaths } from '../../../pi/draft-bridge-directory'
import {
  createPiTerminalDraftDeps,
  type TerminalDraftBridgeDeps,
  type TerminalDraftSubmitInput
} from './terminal-draft-bridge-deps'
import { buildSubmitResult } from './terminal-draft-submit-result'
import { TerminalDraftOperationCache } from './terminal-draft-operation-cache'
import { settleDraftReplace } from './terminal-draft-settlement'

const LEASE_TTL_MS = 5 * 60_000

type Lease = {
  epoch: number
  clientId: string
  clientType: 'desktop' | 'mobile'
  bridgeToken: string
  updatedAt: number
}

function holderOf(lease: Lease): TerminalDraftHolder {
  return { clientId: lease.clientId, clientType: lease.clientType }
}

/**
 * Owns edit epochs and operation results on the execution host. The adapter still owns the real
 * editor text: its source token is the only proof that a replacement would not overwrite a change
 * the remote keyboard made after capture.
 */
export class TerminalDraftCoordinator {
  private readonly leases = new Map<string, Lease>()
  private readonly operations = new TerminalDraftOperationCache()
  private readonly epochCounters = new Map<string, number>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly deps: TerminalDraftBridgeDeps

  constructor(userDataPath: string, deps?: Partial<TerminalDraftBridgeDeps>) {
    this.deps = { ...createPiTerminalDraftDeps(userDataPath), ...deps }
  }

  private async beginLocked(input: {
    ptyId: string
    client: TerminalDraftClient
    force?: boolean
  }): Promise<TerminalDraftBeginResult> {
    const paths = this.deps.readSession(input.ptyId)
    if (!paths) {
      return { ok: false, supported: false, reason: 'no_bridge' }
    }
    const capability = await this.deps.readCapability(paths)
    if (!capability.supported) {
      return {
        ok: false,
        supported: false,
        reason: capability.reason ?? 'unsupported_agent'
      }
    }
    const now = this.deps.now()
    const existing = this.leases.get(input.ptyId)
    const active =
      existing &&
      existing.bridgeToken === paths.session.token &&
      now - existing.updatedAt <= LEASE_TTL_MS
        ? existing
        : null
    if (active && !input.force && active.clientId !== input.client.id) {
      return {
        ok: false,
        supported: true,
        adapter: 'pi-editor',
        processIncarnation: capability.processIncarnation,
        reason: 'locked',
        holder: holderOf(active)
      }
    }
    const sameHolder = active?.clientId === input.client.id
    const epoch = sameHolder && active ? active.epoch : this.nextEpoch(input.ptyId)
    const response = await this.deps.capture(paths)
    if (!response?.ok || typeof response.text !== 'string' || !response.sourceToken) {
      return {
        ok: false,
        supported: true,
        adapter: 'pi-editor',
        processIncarnation: capability.processIncarnation,
        reason: response ? 'invalid_bridge_reply' : 'bridge_timeout'
      }
    }
    this.leases.set(input.ptyId, {
      epoch,
      clientId: input.client.id,
      clientType: input.client.type,
      bridgeToken: paths.session.token,
      updatedAt: now
    })
    return {
      ok: true,
      supported: true,
      adapter: 'pi-editor',
      processIncarnation: capability.processIncarnation,
      epoch,
      text: response.text,
      sourceToken: response.sourceToken
    }
  }

  private releaseLocked(input: { ptyId: string; epoch: number; client: TerminalDraftClient }): {
    ok: boolean
  } {
    const lease = this.leases.get(input.ptyId)
    if (
      !lease ||
      lease.epoch !== input.epoch ||
      lease.clientId !== input.client.id ||
      this.deps.now() - lease.updatedAt > LEASE_TTL_MS
    ) {
      return { ok: false }
    }
    this.leases.delete(input.ptyId)
    return { ok: true }
  }

  begin(input: {
    ptyId: string
    client: TerminalDraftClient
    force?: boolean
  }): Promise<TerminalDraftBeginResult> {
    return this.runExclusive(input.ptyId, () => this.beginLocked(input))
  }

  release(input: {
    ptyId: string
    epoch: number
    client: TerminalDraftClient
  }): Promise<{ ok: boolean }> {
    return this.runExclusive(input.ptyId, () => this.releaseLocked(input))
  }

  save(input: {
    ptyId: string
    client: TerminalDraftClient
    epoch: number
    baseToken: string
    text: string
    operationId: string
  }): Promise<TerminalDraftSaveResult> {
    return this.runExclusive(input.ptyId, () => this.saveLocked(input))
  }

  submit(input: {
    ptyId: string
    client: TerminalDraftClient
    epoch: number
    baseToken: string
    text: string
    operationId: string
    submitInput: TerminalDraftSubmitInput
  }): Promise<TerminalDraftSubmitResult> {
    return this.runExclusive(input.ptyId, () => this.submitLocked(input))
  }

  dispose(ptyId: string): void {
    this.leases.delete(ptyId)
    this.epochCounters.delete(ptyId)
    this.queues.delete(ptyId)
    this.operations.dispose(ptyId)
  }

  private nextEpoch(ptyId: string): number {
    const next = (this.epochCounters.get(ptyId) ?? 0) + 1
    this.epochCounters.set(ptyId, next)
    return next
  }

  private async runExclusive<T>(ptyId: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(ptyId) ?? Promise.resolve()
    const next = previous.then(task, task)
    const guarded = next.catch(() => {})
    this.queues.set(ptyId, guarded)
    try {
      return await next
    } finally {
      if (this.queues.get(ptyId) === guarded) {
        this.queues.delete(ptyId)
      }
    }
  }

  isCurrentLease(ptyId: string, epoch: number, client: TerminalDraftClient): boolean {
    const lease = this.leases.get(ptyId)
    return (
      !!lease &&
      lease.epoch === epoch &&
      lease.clientId === client.id &&
      this.deps.now() - lease.updatedAt <= LEASE_TTL_MS
    )
  }

  private async saveLocked(input: {
    ptyId: string
    client: TerminalDraftClient
    epoch: number
    baseToken: string
    text: string
    operationId: string
  }): Promise<TerminalDraftSaveResult> {
    const cached = this.operations.readSave(input.ptyId, input.operationId)
    if (cached) {
      return cached.ok ? { ...cached, replayed: true } : cached
    }
    const prepared = await this.prepareEdit(input)
    if ('result' in prepared) {
      this.operations.rememberSave(input.ptyId, input.operationId, prepared.result)
      return prepared.result
    }
    const response = await this.deps.replace(prepared.paths, input.text, input.baseToken)
    const result = settleDraftReplace(response)
    this.operations.rememberSave(input.ptyId, input.operationId, result)
    return result
  }

  private async submitLocked(input: {
    ptyId: string
    client: TerminalDraftClient
    epoch: number
    baseToken: string
    text: string
    operationId: string
    submitInput: TerminalDraftSubmitInput
  }): Promise<TerminalDraftSubmitResult> {
    const cached = this.operations.readSubmit(input.ptyId, input.operationId)
    if (cached) {
      return cached.ok ? { ...cached, replayed: true } : cached
    }
    const prepared = await this.prepareEdit(input)
    if ('result' in prepared) {
      const failure =
        prepared.result.status === 'conflict'
          ? ({ ok: false, status: 'conflict', conflict: prepared.result.conflict } as const)
          : prepared.result.status === 'stale_lease'
            ? ({ ok: false, status: 'stale_lease', epoch: prepared.result.epoch } as const)
            : prepared.result.status === 'unknown'
              ? ({ ok: false, status: 'unknown', reason: prepared.result.reason } as const)
              : ({ ok: false, status: 'unsupported', reason: prepared.result.reason } as const)
      this.operations.rememberSubmit(input.ptyId, input.operationId, failure)
      return failure
    }
    const response = await this.deps.replace(prepared.paths, input.text, input.baseToken)
    const replaced = settleDraftReplace(response)
    if (!replaced.ok) {
      this.operations.rememberSubmit(input.ptyId, input.operationId, replaced)
      return replaced
    }
    let result: TerminalDraftSubmitResult
    try {
      result = buildSubmitResult({ replaced, written: await input.submitInput() })
    } catch (error) {
      result = buildSubmitResult({ replaced, error })
    }
    this.operations.rememberSubmit(input.ptyId, input.operationId, result)
    return result
  }

  private async prepareEdit(input: {
    ptyId: string
    client: TerminalDraftClient
    epoch: number
  }): Promise<
    { paths: PiDraftBridgePaths } | { result: Exclude<TerminalDraftSaveResult, { ok: true }> }
  > {
    const lease = this.leases.get(input.ptyId)
    const paths = this.deps.readSession(input.ptyId)
    if (
      !lease ||
      lease.epoch !== input.epoch ||
      lease.clientId !== input.client.id ||
      !paths ||
      paths.session.token !== lease.bridgeToken ||
      this.deps.now() - lease.updatedAt > LEASE_TTL_MS
    ) {
      return { result: { ok: false, status: 'stale_lease', epoch: lease?.epoch ?? 0 } }
    }
    const capability = await this.deps.readCapability(paths)
    if (!capability.supported) {
      return { result: { ok: false, status: 'unsupported', reason: capability.reason } }
    }
    lease.updatedAt = this.deps.now()
    return { paths }
  }
}
