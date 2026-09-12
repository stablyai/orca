import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtyProcessInspection } from './pty-process-inspection'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import { writeToSshPty, writeToSshPtyWithSettlement } from './ssh-pty-write'

export function writeSshPty(mux: SshChannelMultiplexer, relayPtyId: string, data: string): boolean {
  return writeToSshPty(mux, relayPtyId, data)
}

export function writeSshPtyWithSettlement(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  data: string
): Promise<WriteSettlement> {
  return writeToSshPtyWithSettlement(mux, relayPtyId, data)
}

export function resizeSshPty(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  cols: number,
  rows: number
): void {
  mux.notify('pty.resize', { id: relayPtyId, cols, rows })
}

export async function shutdownSshPty(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  opts: {
    immediate?: boolean
    keepHistory?: boolean
    timeoutMs?: number
    expectedIncarnationId?: string
    expectedOwnerClientInstanceId?: string
  }
): Promise<void> {
  await mux.request(
    'pty.shutdown',
    {
      id: relayPtyId,
      immediate: opts.immediate ?? false,
      keepHistory: opts.keepHistory ?? false,
      ...(opts.expectedIncarnationId === undefined
        ? {}
        : { expectedIncarnationId: opts.expectedIncarnationId }),
      ...(opts.expectedOwnerClientInstanceId === undefined
        ? {}
        : { expectedOwnerClientInstanceId: opts.expectedOwnerClientInstanceId })
    },
    opts.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs }
  )
}

export async function sendSignalToSshPty(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  signal: string
): Promise<void> {
  await mux.request('pty.sendSignal', { id: relayPtyId, signal })
}

export async function readSshPtyCwd(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  initial: boolean
): Promise<string> {
  const result = await mux.request(initial ? 'pty.getInitialCwd' : 'pty.getCwd', {
    id: relayPtyId
  })
  return result as string
}

export async function clearSshPtyBuffer(
  mux: SshChannelMultiplexer,
  relayPtyId: string
): Promise<void> {
  await mux.request('pty.clearBuffer', { id: relayPtyId })
}

export async function closeSshPtyStartupQueryAuthority(
  mux: SshChannelMultiplexer,
  relayPtyId: string
): Promise<number> {
  const result = (await mux.request('pty.closeStartupQueryAuthority', {
    id: relayPtyId
  })) as { appliedSeq?: number }
  return result.appliedSeq ?? 0
}

export function acknowledgeSshPtyData(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  charCount: number
): void {
  mux.notify('pty.ackData', { id: relayPtyId, charCount })
}

export async function hasSshPtyChildren(
  mux: SshChannelMultiplexer,
  relayPtyId: string
): Promise<boolean> {
  const result = await mux.request('pty.hasChildProcesses', { id: relayPtyId })
  return result as boolean
}

export async function getSshPtyForegroundProcess(
  mux: SshChannelMultiplexer,
  relayPtyId: string
): Promise<string | null> {
  const result = await mux.request('pty.getForegroundProcess', { id: relayPtyId })
  return result as string | null
}

export async function inspectSshPtyProcess(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  options?: { expectedIncarnationId?: string; scanChildProcesses?: boolean }
): Promise<PtyProcessInspection> {
  return (await mux.request('pty.inspectProcess', {
    id: relayPtyId,
    ...options
  })) as PtyProcessInspection
}

export async function serializeSshPtys(
  mux: SshChannelMultiplexer,
  relayPtyIds: readonly string[]
): Promise<string> {
  const result = await mux.request('pty.serialize', { ids: relayPtyIds })
  return result as string
}

export async function reviveSshPtyState(mux: SshChannelMultiplexer, state: string): Promise<void> {
  await mux.request('pty.revive', { state })
}

export async function getSshDefaultShell(mux: SshChannelMultiplexer): Promise<string> {
  const result = await mux.request('pty.getDefaultShell')
  return result as string
}

export async function getSshShellProfiles(
  mux: SshChannelMultiplexer
): Promise<{ name: string; path: string }[]> {
  const result = await mux.request('pty.getProfiles')
  return result as { name: string; path: string }[]
}
