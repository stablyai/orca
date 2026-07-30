export const PTY_PENDING_PROJECTION_ADMISSION_MAX_IDS = 1024

export type PendingProjectionAdmissions = Readonly<{
  projectionAdmissionIds?: readonly string[]
  projectionAdmissionsTransferred?: true
}>

type PendingProjectionAdmissionOptions = Readonly<{
  isPending: (id: string) => boolean
  transfer: (ids: readonly string[], reason: string) => void
}>

const DEFAULT_OPTIONS: PendingProjectionAdmissionOptions = {
  isPending: () => true,
  transfer: () => {}
}

export function compactPendingProjectionAdmissions(
  state: PendingProjectionAdmissions = {},
  options: PendingProjectionAdmissionOptions = DEFAULT_OPTIONS
): PendingProjectionAdmissions {
  if (state.projectionAdmissionsTransferred) {
    return { projectionAdmissionsTransferred: true }
  }
  const ids = Array.from(
    new Set((state.projectionAdmissionIds ?? []).filter((id) => options.isPending(id)))
  )
  return ids.length > 0 ? { projectionAdmissionIds: ids } : {}
}

export function appendPendingProjectionAdmission(
  state: PendingProjectionAdmissions,
  id: string,
  options: PendingProjectionAdmissionOptions
): PendingProjectionAdmissions {
  if (state.projectionAdmissionsTransferred) {
    options.transfer([id], 'pending-projection-cap')
    return { projectionAdmissionsTransferred: true }
  }
  const compacted = compactPendingProjectionAdmissions(state, options)
  const ids = [...(compacted.projectionAdmissionIds ?? []), id]
  if (ids.length <= PTY_PENDING_PROJECTION_ADMISSION_MAX_IDS) {
    return { projectionAdmissionIds: ids }
  }
  options.transfer(ids, 'pending-projection-cap')
  return { projectionAdmissionsTransferred: true }
}

export function propagatePendingProjectionRemainder(
  state: PendingProjectionAdmissions,
  delivery: Readonly<{ sent: boolean; projectionsTransferred: boolean }>,
  options: PendingProjectionAdmissionOptions
): PendingProjectionAdmissions {
  return delivery.sent && !delivery.projectionsTransferred
    ? compactPendingProjectionAdmissions(state, options)
    : { projectionAdmissionsTransferred: true }
}
