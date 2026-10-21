import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { getRemoteHostPlatform } from '../ssh-remote-platform'
import type { LegacyRelayClient } from './legacy-relay-client'
import type { LegacyRelayEndpoint } from './legacy-relay-endpoints'

export const TARGET = 'ssh-box'
export const PTY = toAppSshPtyId(TARGET, 'pty-1')

export type FakeRelay = {
  ptys: Set<string>
  attachError: Error | null
  clients: FakeClient[]
  openError: Error | null
  shutdowns: string[]
  shutdownError: Error | null
  /** The process identity each listed PTY reports, when the relay reports one. */
  incarnations: Map<string, string>
  /** Whether a stop reports `pty.exit` (the relay's normal answer). */
  exitOnShutdown: boolean
}

export type FakeClient = LegacyRelayClient & {
  emitData: (id: string, data: string) => void
  emitExit: (id: string, code: number) => void
  drop: () => void
  writes: string[]
}

export function fakeClient(relay: FakeRelay): FakeClient {
  const data = new Set<(id: string, data: string) => void>()
  const exits = new Set<(id: string, code: number) => void>()
  const closes = new Set<() => void>()
  let closed = false
  const writes: string[] = []
  const close = (): void => {
    if (!closed) {
      closed = true
      closes.forEach((listener) => listener())
    }
  }
  const client = {
    ownerClaim: { ownerGeneration: 1, ownerLease: 'lease' },
    get closed() {
      return closed
    },
    list: async () =>
      [...relay.ptys].map((relayPtyId) => {
        const incarnationId = relay.incarnations.get(relayPtyId)
        return incarnationId ? { relayPtyId, incarnationId } : { relayPtyId }
      }),
    attach: async () => {
      if (relay.attachError) {
        throw relay.attachError
      }
      return { replay: 'SCREEN' }
    },
    shutdown: async (id: string, expectedIncarnationId?: string) => {
      if (relay.shutdownError) {
        throw relay.shutdownError
      }
      relay.shutdowns.push(expectedIncarnationId ? `${id}#${expectedIncarnationId}` : id)
      relay.ptys.delete(id)
      if (relay.exitOnShutdown) {
        exits.forEach((listener) => listener(id, 0))
      }
    },
    write: (_id: string, chunk: string) => writes.push(chunk),
    resize: () => {},
    onData: (listener: (id: string, data: string) => void) => {
      data.add(listener)
      return () => data.delete(listener)
    },
    onExit: (listener: (id: string, code: number) => void) => {
      exits.add(listener)
      return () => exits.delete(listener)
    },
    onClose: (listener: () => void) => {
      closes.add(listener)
      return () => closes.delete(listener)
    },
    close,
    emitData: (id: string, chunk: string) => data.forEach((listener) => listener(id, chunk)),
    emitExit: (id: string, code: number) => exits.forEach((listener) => listener(id, code)),
    drop: close,
    writes
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge reads only the members this fake implements.
  return client as unknown as FakeClient
}

export const ENDPOINT: LegacyRelayEndpoint = {
  endpoint: '/home/me/.orca-remote/relay-0.1.0+abc/relay-x.sock',
  connectCommand: 'cd x && node relay.js --connect',
  wrapCommand: true,
  host: getRemoteHostPlatform('linux-x64'),
  nodePath: 'node'
}

export function lease(overrides: Partial<SshRemotePtyLease> = {}): SshRemotePtyLease {
  return {
    targetId: TARGET,
    ptyId: 'pty-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    state: 'detached',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

export function newFakeRelay(): FakeRelay {
  return {
    ptys: new Set(['pty-1']),
    attachError: null,
    clients: [],
    openError: null,
    shutdowns: [],
    shutdownError: null,
    incarnations: new Map(),
    exitOnShutdown: true
  }
}
