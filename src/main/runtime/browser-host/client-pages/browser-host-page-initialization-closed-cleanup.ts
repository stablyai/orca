import type {
  Initialization,
  InitializationRecord,
  InitializationAdmission,
  BrowserHostPageInitializationInput
} from './browser-host-page-initialization-records'

export function createInitializationCleanup(
  record: InitializationRecord,
  observer: (input: BrowserHostPageInitializationInput) => InitializationAdmission,
  releaseGrant?: () => void,
  preserveContinuation?: () => boolean
): Initialization {
  const admission = observer({
    browserPageId: record.browserPageId,
    browserProfileId: record.browserProfileId,
    workspaceId: record.workspaceId,
    expected: record.expected,
    url: '',
    isCurrent: () => false,
    resolveExecutionHostKey: async () => null,
    publish: () => {}
  })
  const operation: Initialization = {
    record,
    admission,
    controller: new AbortController(),
    running: false,
    executing: false,
    detached: false,
    phase: 'cleanup',
    preserveContinuation,
    releaseGrant
  }
  operation.controller.abort()
  return operation
}
