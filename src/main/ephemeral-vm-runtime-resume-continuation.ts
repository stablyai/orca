import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { ResumeEphemeralVmRuntimeResult } from './ephemeral-vm-runtime-service-types'

type ResumeWorkspaceResult = EphemeralVmRuntimeRecord | null

export function createEphemeralVmRuntimeResumeCoordinator(): (
  runtimeId: string,
  resume: () => Promise<ResumeWorkspaceResult>
) => Promise<ResumeWorkspaceResult> {
  const inFlight = new Map<string, Promise<ResumeWorkspaceResult>>()
  return (runtimeId, resume) => {
    const existing = inFlight.get(runtimeId)
    if (existing) {
      return existing
    }
    const request = resume().finally(() => {
      if (inFlight.get(runtimeId) === request) {
        inFlight.delete(runtimeId)
      }
    })
    inFlight.set(runtimeId, request)
    return request
  }
}

export function continueEphemeralVmRuntimeResume(
  runtime: EphemeralVmRuntimeRecord,
  resumeProvider: () => Promise<ResumeEphemeralVmRuntimeResult>
): Promise<ResumeEphemeralVmRuntimeResult> {
  return runtime.resumeConnectionPending
    ? Promise.resolve({ ok: true, runtime, skipped: false })
    : resumeProvider()
}
