import {
  inspectPtyProviderProcess,
  type PtyProcessInspection
} from '../providers/pty-process-inspection'
import type { IPtyProvider } from '../providers/types'
import { ensurePtyProcessInspectionEvidence } from '../../shared/pty-process-inspection-evidence'

export async function inspectDegradedDaemonPtyProcess(
  id: string,
  hasPty: (id: string) => boolean,
  resolveProvider: (id: string) => IPtyProvider
): Promise<PtyProcessInspection> {
  if (!hasPty(id)) {
    throw new Error('terminal_gone')
  }
  return ensurePtyProcessInspectionEvidence(
    await inspectPtyProviderProcess(resolveProvider(id), id)
  )
}
