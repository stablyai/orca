import type {
  TerminalDraftBeginResult,
  TerminalDraftClient,
  TerminalDraftHolder,
  TerminalDraftSaveResult,
  TerminalDraftSubmitResult
} from '../../../../shared/terminal-draft-contract'
import {
  readPiDraftBridgeCapability,
  requestPiDraftCapture,
  requestPiDraftReplace,
  type PiDraftBridgeCapability
} from '../../../pi/draft-bridge-client'
import {
  readPiDraftBridgeSession,
  type PiDraftBridgePaths
} from '../../../pi/draft-bridge-directory'
import type { PiDraftBridgeResponse } from '../../../pi/draft-bridge-protocol'
import type { WriteSettlement } from '../../../../shared/pty-write-settlement'
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

export type TerminalDraftBridgeDeps = {
  readSession: (ptyId: string) => PiDraftBridgePaths | null
  readCapability: (paths: PiDraftBridgePaths) => Promise<PiDraftBridgeCapability>
  capture: (paths: PiDraftBridgePaths) => Promise<PiDraftBridgeResponse | null>
  replace: (
    paths: PiDraftBridgePaths,
    text: string,
    baseToken: string
  ) => Promise<PiDraftBridgeResponse | null>
  now: () => number
}

export type TerminalDraftSubmitInput = () => Promise<{
  accepted: boolean
  writeSettlement?: WriteSettlement
}>

const defaultDeps = (userDataPath: string): TerminalDraftBridgeDeps => ({
  readSession: (ptyId) => readPiDraftBridgeSession(userDataPath, ptyId),
  readCapability: (paths) => readPiDraftBridgeCapability(paths),
  capture: (paths) => requestPiDraftCapture(paths),
  replace: (paths, text, baseToken) => requestPiDraftReplace(paths, text, baseToken),
  now: () => Date.now()
})

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
  private readonly deps: TerminalDraftBridgeDeps

  constructor(userDataPath: string, deps?: Partial<TerminalDraftBridgeDeps>) {
    this.deps = { ...defaultDeps(userDataPath), ...deps }
  }

  async begin(input: {
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
    const epoch = sameHolder && active ? active.epoch : (existing?.epoch ?? 0) + 1
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

  release(input: { ptyId: string; epoch: number; client: TerminalDraftClient }): { ok: boolean } {
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

  isCurrentLease(ptyId: string, epoch: number, client: TerminalDraftClient): boolean {
    const lease = this.leases.get(ptyId)
    return (
      !!lease &&
      lease.epoch === epoch &&
      lease.clientId === client.id &&
      this.deps.now() - lease.updatedAt <= LEASE_TTL_MS
    )
  }

  async save(input: {
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

  async submit(input: {
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
      const written = await input.submitInput()
      const settlement = written.writeSettlement
      if (settlement?.outcome === 'unverifiable') {
        result = {
          ok: true,
          status: 'submit_unknown',
          sourceToken: replaced.sourceToken,
          reason: settlement.reason
        }
      } else if (written.accepted) {
        result = { ok: true, status: 'submitted', sourceToken: replaced.sourceToken }
      } else {
        result = {
          ok: true,
          status: 'saved_not_submitted',
          sourceToken: replaced.sourceToken,
          submitRefused: true
        }
      }
    } catch (error) {
      result = {
        ok: true,
        status: 'submit_unknown',
        sourceToken: replaced.sourceToken,
        reason: error instanceof Error ? error.message : 'submit_failed'
      }
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
