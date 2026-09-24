import { describe, expect, it } from 'vitest'
import { FederationAttachStartParams } from './federation-start-schema'

// The request shape a v1.4.198 coordinator sends: no runId field at all.
const legacyRequest = {
  dispatchId: 'ctx_legacy',
  taskId: 'task_legacy',
  taskSpec: 'Do the thing',
  protocolVersion: 3,
  worktree: 'feature-branch'
}

describe('FederationAttachStartParams', () => {
  it('parses a v1.4.198 request that carries no runId', () => {
    const result = FederationAttachStartParams.safeParse(legacyRequest)
    expect(result.success, result.success ? undefined : JSON.stringify(result.error.issues)).toBe(
      true
    )
    expect(result.success && result.data.runId).toBeUndefined()
  })

  it('keeps a v1.4.199 runId verbatim', () => {
    const result = FederationAttachStartParams.parse({ ...legacyRequest, runId: 'run_home' })
    expect(result.runId).toBe('run_home')
  })

  // Pins OptionalString: '' and non-strings drop to undefined (a stub Run is minted downstream);
  // whitespace-only passes the schema and is refused by createRemoteDispatchAttachment.
  it('maps an empty or non-string runId to undefined but passes whitespace through', () => {
    expect(FederationAttachStartParams.parse({ ...legacyRequest, runId: '' }).runId).toBeUndefined()
    expect(FederationAttachStartParams.parse({ ...legacyRequest, runId: 7 }).runId).toBeUndefined()
    expect(FederationAttachStartParams.parse({ ...legacyRequest, runId: '   ' }).runId).toBe('   ')
  })

  it('still requires the dispatch, task, spec, and worktree fields', () => {
    for (const field of ['dispatchId', 'taskId', 'taskSpec', 'worktree'] as const) {
      const { [field]: _dropped, ...rest } = legacyRequest
      expect(FederationAttachStartParams.safeParse(rest).success, field).toBe(false)
    }
  })
})
