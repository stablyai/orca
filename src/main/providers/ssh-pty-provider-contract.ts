import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtyProcessInfo } from './pty-process-info'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  createPtyStopReceipt,
  parsePtyStopReceipt,
  type PtyStopReceipt
} from '../../shared/pty-stop-receipt'

export type SshPtyCapabilities = {
  stopReceiptVersion?: number
}

type SshPtyStopRequest = {
  mux: SshChannelMultiplexer
  connectionId: string
  appPtyId: string
  relayPtyId: string
  session?: PtyProcessInfo
  opts: {
    immediate?: boolean
    keepHistory?: boolean
    deadlineMs?: number
    expectedIncarnationId?: string
    expectedOwnerClientInstanceId?: string
  }
}

type CoordinatedSshPtyStopRequest = Omit<SshPtyStopRequest, 'session'> & {
  resolveSession(): Promise<PtyProcessInfo | undefined>
}

export class SshPtyStopCoordinator {
  private receipts = new Map<string, PtyStopReceipt>()

  clear(appPtyId: string): void {
    this.receipts.delete(appPtyId)
  }

  clearAll(): void {
    this.receipts.clear()
  }

  async request(args: CoordinatedSshPtyStopRequest): Promise<PtyStopReceipt> {
    const cached = this.receipts.get(args.appPtyId)
    if (cached) {
      if (
        args.opts.expectedIncarnationId &&
        cached.ptyIncarnation !== args.opts.expectedIncarnationId
      ) {
        throw new Error('pty_stop_receipt_identity_mismatch')
      }
      return cached
    }
    const { resolveSession, ...request } = args
    const receipt = await requestSshPtyStop({ ...request, session: await resolveSession() })
    this.receipts.set(args.appPtyId, receipt)
    return receipt
  }
}

async function requestSshPtyStop(args: SshPtyStopRequest): Promise<PtyStopReceipt> {
  const ptyIncarnation = args.opts.expectedIncarnationId ?? args.session?.incarnationId
  if (!ptyIncarnation) {
    throw new Error('pty_stop_receipt_unavailable')
  }
  if (args.session && args.session.incarnationId !== ptyIncarnation) {
    throw new Error('pty_stop_receipt_identity_mismatch')
  }
  const timeout = relayStopTimeout(args.opts.deadlineMs)
  const capabilities = (await args.mux.request(
    'pty.getCapabilities',
    undefined,
    timeout
  )) as SshPtyCapabilities
  const executionHostId = toSshExecutionHostId(args.connectionId)
  const rawReceipt = await args.mux.request(
    'pty.shutdown',
    {
      id: args.relayPtyId,
      immediate: args.opts.immediate ?? false,
      keepHistory: args.opts.keepHistory ?? false,
      ...(capabilities.stopReceiptVersion === 1
        ? {
            expectedIncarnationId: ptyIncarnation,
            executionHostId,
            ...(args.opts.expectedOwnerClientInstanceId
              ? { expectedOwnerClientInstanceId: args.opts.expectedOwnerClientInstanceId }
              : {})
          }
        : {})
    },
    timeout
  )
  const receipt =
    capabilities.stopReceiptVersion === 1
      ? parsePtyStopReceipt(rawReceipt, {
          executionHostId,
          terminalHandle: args.session?.terminalHandle,
          ptyId: args.relayPtyId,
          ptyIncarnation
        })
      : createCapabilityLimitedSshStopReceipt({
          executionHostId,
          terminalHandle: args.session?.terminalHandle ?? args.relayPtyId,
          ptyId: args.relayPtyId,
          ptyIncarnation
        })
  return parsePtyStopReceipt(
    { ...receipt, ptyId: args.appPtyId },
    {
      executionHostId,
      terminalHandle: args.session?.terminalHandle,
      ptyId: args.appPtyId,
      ptyIncarnation
    }
  )
}

function createCapabilityLimitedSshStopReceipt(
  identity: Pick<PtyStopReceipt, 'executionHostId' | 'terminalHandle' | 'ptyId' | 'ptyIncarnation'>
): PtyStopReceipt {
  const root = { pid: null, parentPid: null, processGroupId: null, startedAt: null }
  return createPtyStopReceipt({
    ...identity,
    root,
    descendants: [],
    observations: [
      { identity: root, status: 'unverifiable', observedAt: new Date().toISOString() }
    ],
    verdict: 'capability_limited',
    processTreeVerified: false,
    reason: 'The SSH relay does not support process-tree stop receipts.'
  })
}

function relayStopTimeout(deadlineMs: number | undefined): { timeoutMs: number } | undefined {
  return deadlineMs === undefined ? undefined : { timeoutMs: Math.max(1, deadlineMs - Date.now()) }
}

export type RemoteCliBridgeEnv = {
  binDir: string
  /** Exact remote executable produced by RemoteCliInstallPlan. */
  launcherPath?: string
  relayDir: string
  nodePath: string
  sockPath: string
  credentialFile?: string
  pathDelimiter?: ':' | ';'
}

export type SshPtyDataCallback = (payload: {
  id: string
  data: string
  providerGeneration: number
  ptyIncarnation: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
  source?: Readonly<{
    relayPtyId: string
    spanId: string
    clientGeneration: number
    ownerGeneration: number
    deliveryToken: string
    sourceStartSu: number
    sourceEndSu: number
  }>
  sourceMalformed?: boolean
  sourceRejected?: boolean
  rejectedSourceRecovery?: 'confirm-existing' | 'fresh-activation' | 'reconnect-channel'
}) => void
export type SshPtyReplayCallback = (payload: { id: string; data: string }) => void
export type SshPtyExitCallback = (payload: {
  id: string
  code: number
  providerGeneration: number
  ptyIncarnation: string
  incarnationId?: PtyIncarnationId
}) => void

export type SshPtyDeliveryPauseAdapter = (args: {
  id: string
  providerGeneration: number
  paused: boolean
}) => void
