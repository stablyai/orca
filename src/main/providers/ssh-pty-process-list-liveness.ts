import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtyProcessInfo } from './types'
import { mapSshPtyProcessList } from './ssh-agent-session-process-list'
import type { SshPtyLivenessState, SshPtyLiveEvidence } from './ssh-pty-liveness-state'

export async function listSshPtyProcessesWithLiveEvidence(args: {
  mux: SshChannelMultiplexer
  deadlineMs?: number
  toAppPtyId: (id: string) => string
  toRelayPtyId: (id: string) => string
  livenessState: SshPtyLivenessState
  rememberPtyIncarnation: (relayPtyId: string, incarnationId: unknown) => void
}): Promise<PtyProcessInfo[]> {
  const pendingEvidence = new Map<string, SshPtyLiveEvidence>()
  const evidenceWindow = args.livenessState.beginLiveEvidenceWindow()
  const mapProcesses = (value: unknown): PtyProcessInfo[] =>
    mapSshPtyProcessList(value as PtyProcessInfo[], args.toAppPtyId)
  try {
    const result = await args.mux.request('pty.listProcesses', undefined, {
      ...(args.deadlineMs === undefined
        ? {}
        : { timeoutMs: Math.max(1, args.deadlineMs - Date.now()) }),
      beforeResolve: (value) => {
        for (const process of mapProcesses(value)) {
          if (!pendingEvidence.has(process.id)) {
            pendingEvidence.set(
              process.id,
              args.livenessState.beginLiveEvidence(process.id, evidenceWindow)
            )
          }
        }
      }
    })
    const processes = mapProcesses(result)
    for (const process of processes) {
      const evidence =
        pendingEvidence.get(process.id) ??
        args.livenessState.beginLiveEvidence(process.id, evidenceWindow)
      args.livenessState.settleLiveEvidence(process.id, evidence, true)
      pendingEvidence.delete(process.id)
      args.rememberPtyIncarnation(args.toRelayPtyId(process.id), process.incarnationId)
    }
    return processes
  } finally {
    for (const [id, evidence] of pendingEvidence) {
      args.livenessState.settleLiveEvidence(id, evidence, false)
    }
    args.livenessState.closeLiveEvidenceWindow(evidenceWindow)
  }
}
