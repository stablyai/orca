export type ActiveLineageContext = {
  parentWorkspaceKey: string
  parentSessionId: string
}

let activeLineageContext: ActiveLineageContext | null = null

export function setActiveLineageContext(context: ActiveLineageContext | null): void {
  activeLineageContext = context
  if (context) {
    process.env.ORCA_PARENT_WORKSPACE_KEY = context.parentWorkspaceKey
    process.env.ORCA_PARENT_SESSION_ID = context.parentSessionId
  } else {
    delete process.env.ORCA_PARENT_WORKSPACE_KEY
    delete process.env.ORCA_PARENT_SESSION_ID
  }
}

export function getActiveLineageContext(): ActiveLineageContext | null {
  if (activeLineageContext) {
    return activeLineageContext
  }
  const parentKey = process.env.ORCA_PARENT_WORKSPACE_KEY
  const parentSession = process.env.ORCA_PARENT_SESSION_ID
  if (parentKey) {
    return {
      parentWorkspaceKey: parentKey,
      parentSessionId: parentSession ?? ''
    }
  }
  return null
}

export function clearActiveLineageContext(): void {
  setActiveLineageContext(null)
}

export function injectLineageEnv<T extends Record<string, string | undefined>>(
  targetEnv: T,
  sourceContext?: Partial<ActiveLineageContext> | Record<string, string | undefined> | null
): T {
  const context = getActiveLineageContext()
  const source: Record<string, string | undefined> = sourceContext ?? {}
  const parentWorkspaceKey =
    source.parentWorkspaceKey ??
    source.ORCA_PARENT_WORKSPACE_KEY ??
    context?.parentWorkspaceKey ??
    process.env.ORCA_PARENT_WORKSPACE_KEY

  const parentSessionId =
    source.parentSessionId ??
    source.ORCA_PARENT_SESSION_ID ??
    context?.parentSessionId ??
    process.env.ORCA_PARENT_SESSION_ID

  if (parentWorkspaceKey) {
    Object.assign(targetEnv, { ORCA_PARENT_WORKSPACE_KEY: parentWorkspaceKey })
  }
  if (parentSessionId) {
    Object.assign(targetEnv, { ORCA_PARENT_SESSION_ID: parentSessionId })
  }
  return targetEnv
}
