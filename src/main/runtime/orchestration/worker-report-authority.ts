import type { DispatchContextRow } from './types'
import { z } from 'zod'

export type WorkerReportAuthority = {
  terminalHandle: string
  paneKey: string
  processIncarnation: string
  consumerGeneration: number
}

const WorkerReportAuthoritySchema = z.object({
  terminalHandle: z.string(),
  paneKey: z.string(),
  processIncarnation: z.string(),
  consumerGeneration: z.number()
})

export function parseWorkerReportAuthority(
  payload: Record<string, unknown>
): WorkerReportAuthority | undefined {
  const value = payload.providerSenderAttestation
  const parsed = WorkerReportAuthoritySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function hasCurrentWorkerReportAuthority(
  dispatch: DispatchContextRow,
  authority: WorkerReportAuthority
): boolean {
  return (
    dispatch.assignee_handle === authority.terminalHandle &&
    dispatch.assignee_pane_key === authority.paneKey &&
    dispatch.process_incarnation === authority.processIncarnation &&
    dispatch.consumer_generation === authority.consumerGeneration
  )
}
