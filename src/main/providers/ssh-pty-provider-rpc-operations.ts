import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtyProcessInspection } from './pty-process-inspection'
import { writeToSshPty, writeToSshPtyWithSettlement } from './ssh-pty-write'

type SshPtyProviderRpcContext = {
  mux: SshChannelMultiplexer
  toRelayPtyId: (id: string) => string
}

/** RPC leaves that only need the SSH mux and relay-id mapping. */
export function createSshPtyProviderRpcOperations({ mux, toRelayPtyId }: SshPtyProviderRpcContext) {
  return {
    deleteWorktreeHistory: async (worktreeId: string): Promise<void> => {
      await mux.request('pty.deleteWorktreeHistory', { worktreeId })
    },
    write: (id: string, data: string): boolean => writeToSshPty(mux, toRelayPtyId(id), data),
    writeWithSettlement: (id: string, data: string): Promise<boolean> =>
      writeToSshPtyWithSettlement(mux, toRelayPtyId(id), data),
    resize: (id: string, cols: number, rows: number): void => {
      mux.notify('pty.resize', { id: toRelayPtyId(id), cols, rows })
    },
    sendSignal: async (id: string, signal: string): Promise<void> => {
      await mux.request('pty.sendSignal', { id: toRelayPtyId(id), signal })
    },
    getCwd: async (id: string): Promise<string> => {
      const result = await mux.request('pty.getCwd', { id: toRelayPtyId(id) })
      return result as string
    },
    getInitialCwd: async (id: string): Promise<string> => {
      const result = await mux.request('pty.getInitialCwd', { id: toRelayPtyId(id) })
      return result as string
    },
    clearBuffer: async (id: string): Promise<void> => {
      await mux.request('pty.clearBuffer', { id: toRelayPtyId(id) })
    },
    closeStartupQueryAuthority: async (id: string): Promise<number> => {
      const result = (await mux.request('pty.closeStartupQueryAuthority', {
        id: toRelayPtyId(id)
      })) as { appliedSeq?: number }
      return result.appliedSeq ?? 0
    },
    acknowledgeDataEvent: (id: string, charCount: number): void => {
      mux.notify('pty.ackData', { id: toRelayPtyId(id), charCount })
    },
    hasChildProcesses: async (id: string): Promise<boolean> => {
      const result = await mux.request('pty.hasChildProcesses', { id: toRelayPtyId(id) })
      return result as boolean
    },
    getForegroundProcess: async (id: string): Promise<string | null> => {
      const result = await mux.request('pty.getForegroundProcess', { id: toRelayPtyId(id) })
      return result as string | null
    },
    inspectProcess: async (
      id: string,
      options?: { expectedIncarnationId?: string }
    ): Promise<PtyProcessInspection> => {
      return (await mux.request('pty.inspectProcess', {
        id: toRelayPtyId(id),
        ...(options?.expectedIncarnationId
          ? { expectedIncarnationId: options.expectedIncarnationId }
          : {})
      })) as PtyProcessInspection
    },
    serialize: async (ids: string[]): Promise<string> => {
      const result = await mux.request('pty.serialize', {
        ids: ids.map((id) => toRelayPtyId(id))
      })
      return result as string
    },
    revive: async (state: string): Promise<void> => {
      await mux.request('pty.revive', { state })
    },
    getDefaultShell: async (): Promise<string> => {
      const result = await mux.request('pty.getDefaultShell')
      return result as string
    },
    getProfiles: async (): Promise<{ name: string; path: string }[]> => {
      const result = await mux.request('pty.getProfiles')
      return result as { name: string; path: string }[]
    }
  }
}
