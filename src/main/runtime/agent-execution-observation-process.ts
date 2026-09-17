import { isShellProcess } from '../../shared/agent-detection'
import type {
  ForegroundProcessEvidence,
  RemoteForegroundEvidence
} from '../../shared/foreground-process-evidence'
import type { AgentExecutionAttachment } from '../../shared/agent-execution-observation'
import type { AgentStatusRunVerdict } from '../../shared/agent-status-run'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { withTimeoutResult } from './runtime-async-boundaries'

export function processIncarnation(process: PtyProcessInfo): string | null {
  return process.incarnationId ? `${process.id}:${process.incarnationId}` : null
}

export function processIncarnations(processes: readonly PtyProcessInfo[]): ReadonlySet<string> {
  const identities = new Set<string>()
  for (const process of processes) {
    const identity = processIncarnation(process)
    if (identity) {
      identities.add(identity)
    }
  }
  return identities
}

export async function inspectProcessVerdicts(
  controller: RuntimePtyController,
  attachments: readonly AgentExecutionAttachment[],
  processes: readonly PtyProcessInfo[],
  deadlineAtMs: number,
  signal: AbortSignal
): Promise<ReadonlyMap<string, AgentStatusRunVerdict>> {
  const processByIdentity = new Map(
    processes
      .map((process) => {
        const identity = processIncarnation(process)
        return identity ? ([identity, process] as const) : null
      })
      .filter((entry): entry is readonly [string, PtyProcessInfo] => entry !== null)
  )
  const verdicts = new Map<string, AgentStatusRunVerdict>()
  const inspectable = attachments.filter(
    (attachment) => attachment.processIncarnation && attachment.processId
  )
  const workers = Math.min(8, Math.max(1, inspectable.length))
  let next = 0
  const inspectOne = async (): Promise<void> => {
    while (next < inspectable.length) {
      const attachment = inspectable[next++]
      if (signal.aborted || !attachment.processIncarnation || !attachment.processId) {
        return
      }
      if (!processByIdentity.has(attachment.processIncarnation)) {
        verdicts.set(attachment.processIncarnation, 'exited')
        continue
      }
      const process = processByIdentity.get(attachment.processIncarnation)
      if (process?.foregroundProcessEvidence) {
        verdicts.set(
          attachment.processIncarnation,
          verdictFromForegroundEvidence(process.foregroundProcessEvidence)
        )
        continue
      }
      if (!controller.inspectProcess) {
        verdicts.set(attachment.processIncarnation, 'unverifiable')
        continue
      }
      const inspection = await withTimeoutResult(
        controller.inspectProcess(attachment.processId, {
          expectedIncarnationId: attachment.processIncarnationId,
          scanChildProcesses: true
        }),
        Math.max(1, deadlineAtMs - Date.now())
      )
      verdicts.set(
        attachment.processIncarnation,
        inspection.ok ? verdictFromInspection(inspection.value) : 'unverifiable'
      )
    }
  }
  await Promise.all(Array.from({ length: workers }, () => inspectOne()))
  return verdicts
}

function verdictFromInspection(
  inspection: Awaited<ReturnType<NonNullable<RuntimePtyController['inspectProcess']>>>
): AgentStatusRunVerdict {
  const evidence = inspection.foregroundProcessEvidence
  if (evidence) {
    return verdictFromForegroundEvidence(evidence)
  }
  if (inspection.childProcessEvidence === 'children' || inspection.hasChildProcesses) {
    return 'live'
  }
  if (inspection.childProcessEvidence === 'unverifiable') {
    return 'unverifiable'
  }
  if (inspection.childProcessEvidence === 'no-children') {
    return 'exited'
  }
  if (inspection.foregroundProcess === null) {
    return 'unverifiable'
  }
  return isShellProcess(inspection.foregroundProcess) ? 'exited' : 'live'
}

function verdictFromForegroundEvidence(
  evidence: ForegroundProcessEvidence | RemoteForegroundEvidence
): AgentStatusRunVerdict {
  if (evidence.verdict === 'exited' || evidence.verdict === 'unverifiable') {
    return evidence.verdict
  }
  return evidence.shellOwnsEveryTtyProcessGroup === true ? 'exited' : 'live'
}
