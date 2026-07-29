// Pure predicate extracted from register-core-handlers.ts's dev-transition
// registration call, so the packaging gate (plan §15, item 10) is directly
// unit-testable without mocking the entire IPC registration module graph.
export function shouldRegisterAuditedWorkflowDevTransitions(isPackaged: boolean): boolean {
  return !isPackaged
}
