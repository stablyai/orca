import type * as pty from 'node-pty'
import {
  createPtyStopReceipt,
  type PtyStopProcessIdentity,
  type PtyStopReceipt
} from '../../shared/pty-stop-receipt'

export const WINDOWS_PTY_JOB_OBJECT_CAPABILITY_VERSION = 1 as const

type NativeWindowsJobStopReceipt = {
  version: typeof WINDOWS_PTY_JOB_OBJECT_CAPABILITY_VERSION
  assigned: true
  processTreeVerified: true
  identities: PtyStopProcessIdentity[]
}

type JobObjectPty = pty.IPty & {
  windowsJobObjectAssigned?: unknown
  windowsJobObjectStopReceipt?: unknown
}

type RegisteredOwner = { process: pty.IPty; enabled: boolean }
const registeredOwners = new Map<string, RegisteredOwner>()
const settledEvidence = new Map<string, NativeWindowsJobStopReceipt>()

export class WindowsPtyJobObjectReceiptHandoff {
  private readonly receipts = new Map<string, PtyStopReceipt>()
  private readonly operations = new WeakMap<Promise<PtyStopReceipt>, Promise<PtyStopReceipt>>()

  clearForCreate(ownerId: string): void {
    this.receipts.delete(ownerId)
  }

  private read(ownerId: string, expectedIncarnationId?: string): PtyStopReceipt | null {
    const receipt = this.receipts.get(ownerId)
    if (!receipt) {
      return null
    }
    return !expectedIncarnationId || receipt.ptyIncarnation === expectedIncarnationId
      ? receipt
      : null
  }

  resolve(
    ownerId: string,
    operation: Promise<PtyStopReceipt> | null,
    expectedIncarnationId?: string
  ): Promise<PtyStopReceipt> | null {
    if (!operation) {
      const receipt = this.read(ownerId, expectedIncarnationId)
      return receipt ? Promise.resolve(receipt) : null
    }
    const existing = this.operations.get(operation)
    const upgraded =
      existing ??
      operation.then((receipt) => {
        const exact = upgradeWindowsPtyJobObjectStopReceipt(ownerId, receipt)
        if (exact !== receipt) {
          this.receipts.set(ownerId, exact)
        }
        return exact
      })
    if (!existing) {
      this.operations.set(operation, upgraded)
    }
    if (!expectedIncarnationId) {
      return upgraded
    }
    return upgraded.then((receipt) => {
      if (receipt.ptyIncarnation !== expectedIncarnationId) {
        throw new Error('pty_stop_receipt_identity_mismatch')
      }
      return receipt
    })
  }

  clear(): void {
    this.receipts.clear()
  }
}

export function hasWindowsPtyJobObjectOwnership(
  process: pty.IPty,
  options: { platform?: NodeJS.Platform; isWsl?: boolean } = {}
): boolean {
  return (
    (options.platform ?? globalThis.process.platform) === 'win32' &&
    options.isWsl !== true &&
    (process as JobObjectPty).windowsJobObjectAssigned === true
  )
}

export function registerWindowsPtyJobObjectOwner(
  ownerId: string,
  process: pty.IPty,
  options: { platform?: NodeJS.Platform; isWsl?: boolean } = {}
): boolean {
  settledEvidence.delete(ownerId)
  const enabled = hasWindowsPtyJobObjectOwnership(process, options)
  registeredOwners.set(ownerId, { process, enabled })
  return enabled
}

export function releaseWindowsPtyJobObjectOwner(ownerId: string): void {
  const owner = registeredOwners.get(ownerId)
  if (!owner) {
    return
  }
  const evidence = owner.enabled ? parseNativeStopReceipt(owner.process) : null
  if (evidence) {
    settledEvidence.set(ownerId, evidence)
  }
  registeredOwners.delete(ownerId)
}

export function forgetWindowsPtyJobObjectOwner(ownerId: string): void {
  registeredOwners.delete(ownerId)
  settledEvidence.delete(ownerId)
}

export function readWindowsPtyJobObjectStopEvidence(
  process: pty.IPty
): NativeWindowsJobStopReceipt | null {
  return parseNativeStopReceipt(process)
}

export function upgradeWindowsPtyJobObjectStopReceipt(
  ownerId: string,
  fallback: PtyStopReceipt
): PtyStopReceipt {
  const owner = registeredOwners.get(ownerId)
  const evidence =
    (owner?.enabled ? parseNativeStopReceipt(owner.process) : null) ?? settledEvidence.get(ownerId)
  if (!evidence) {
    return fallback
  }
  const root = evidence.identities.find(({ pid }) => pid === fallback.root.pid)
  if (!root) {
    return fallback
  }
  const descendants = evidence.identities.filter(({ pid }) => pid !== root.pid)
  const observedAt = new Date().toISOString()
  const receipt = createPtyStopReceipt({
    executionHostId: fallback.executionHostId,
    terminalHandle: fallback.terminalHandle,
    ptyId: fallback.ptyId,
    ptyIncarnation: fallback.ptyIncarnation,
    root,
    descendants,
    observations: evidence.identities.map((identity) => ({
      identity,
      status: 'absent' as const,
      observedAt
    })),
    verdict: 'exited',
    processTreeVerified: true
  })
  forgetWindowsPtyJobObjectOwner(ownerId)
  return receipt
}

export function constrainWindowsJobObjectStopReceipt(
  receipt: PtyStopReceipt,
  options: { supported: boolean; platform?: NodeJS.Platform; isWsl: boolean }
): PtyStopReceipt {
  if ((options.platform ?? process.platform) !== 'win32') {
    return receipt
  }
  if (options.supported && !options.isWsl) {
    return receipt
  }
  const root = { pid: null, parentPid: null, processGroupId: null, startedAt: null }
  return createPtyStopReceipt({
    executionHostId: receipt.executionHostId,
    terminalHandle: receipt.terminalHandle,
    ptyId: receipt.ptyId,
    ptyIncarnation: receipt.ptyIncarnation,
    root,
    descendants: [],
    observations: [
      { identity: root, status: 'unverifiable', observedAt: new Date().toISOString() }
    ],
    verdict: 'capability_limited',
    processTreeVerified: false,
    reason: options.isWsl
      ? 'WSL process ownership is outside the Windows Job Object.'
      : 'The daemon peer does not support exact Windows Job Object cleanup.'
  })
}

function parseNativeStopReceipt(process: pty.IPty): NativeWindowsJobStopReceipt | null {
  const value = (process as JobObjectPty).windowsJobObjectStopReceipt
  if (!isRecord(value) || value.version !== WINDOWS_PTY_JOB_OBJECT_CAPABILITY_VERSION) {
    return null
  }
  if (value.assigned !== true || value.processTreeVerified !== true) {
    return null
  }
  if (!Array.isArray(value.identities) || value.identities.length === 0) {
    return null
  }
  const identities = value.identities.map(parseIdentity)
  if (identities.some((identity) => identity === null)) {
    return null
  }
  const exact = identities.filter(
    (identity): identity is PtyStopProcessIdentity => identity !== null
  )
  if (new Set(exact.map(({ pid }) => pid)).size !== exact.length) {
    return null
  }
  return {
    version: WINDOWS_PTY_JOB_OBJECT_CAPABILITY_VERSION,
    assigned: true,
    processTreeVerified: true,
    identities: exact
  }
}

function parseIdentity(value: unknown): PtyStopProcessIdentity | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    return null
  }
  if (typeof value.startedAt !== 'string' || value.startedAt.length === 0) {
    return null
  }
  if (value.parentPid !== null || value.processGroupId !== null) {
    return null
  }
  return {
    pid: Number(value.pid),
    parentPid: null,
    processGroupId: null,
    startedAt: value.startedAt
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
