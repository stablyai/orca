import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IPtyProvider, PtyProcessInfo } from './types'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import { mapSshPtyProcessList } from './ssh-agent-session-process-list'
import type { SshPtyProviderOutputState } from './ssh-pty-provider-output-state'

export function createSshPtyProcessLister(
  args: Pick<
    Parameters<typeof listSshPtyProcesses>[0],
    'mux' | 'connectionId' | 'livePtyIds' | 'worktreeIdByPtyId' | 'outputState'
  >
): IPtyProvider['listProcesses'] {
  return (options) =>
    listSshPtyProcesses({
      ...args,
      includeForegroundProcessEvidence: options?.includeForegroundProcessEvidence,
      deadlineMs: options?.deadlineMs
    })
}

export async function listSshPtyProcesses(
  args: Readonly<{
    mux: SshChannelMultiplexer
    connectionId: string
    livePtyIds: Set<string>
    /** Overrides from setWorktreeId rebinds the relay does not report back yet. */
    worktreeIdByPtyId?: Map<string, string>
    outputState: SshPtyProviderOutputState
    includeForegroundProcessEvidence?: boolean
    deadlineMs?: number
  }>
): Promise<PtyProcessInfo[]> {
  const result = await args.mux.request(
    'pty.listProcesses',
    args.includeForegroundProcessEvidence === undefined
      ? undefined
      : { includeForegroundProcessEvidence: args.includeForegroundProcessEvidence },
    args.deadlineMs === undefined
      ? undefined
      : { timeoutMs: Math.max(1, args.deadlineMs - Date.now()) }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay answers pty.listProcesses with PtyProcessInfo rows; the mapper rejects unproven ownership.
  const processes = mapSshPtyProcessList(result as PtyProcessInfo[], (id) =>
    toAppSshPtyId(args.connectionId, id)
  )
  for (const process of processes) {
    args.livePtyIds.add(process.id)
    const remappedWorktreeId = args.worktreeIdByPtyId?.get(process.id)
    if (remappedWorktreeId) {
      process.worktreeId = remappedWorktreeId
    }
    args.outputState.rememberPtyIncarnation(
      toRelaySshPtyId(args.connectionId, process.id),
      process.incarnationId
    )
  }
  return processes
}
