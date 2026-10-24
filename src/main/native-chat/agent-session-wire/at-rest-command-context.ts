import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'

const listeners = new Set<(workspaceId?: string) => void>()
let readiness: Promise<void> | undefined
const launchSettings = new Set([
  'agentCmdOverrides',
  'agentDefaultArgs',
  'agentDefaultEnv',
  'agentPermissionDefault',
  'agentPermissionOverrides',
  'nativeChatInheritShellEnvironment',
  'nativeChatShellEnvironmentVariables',
  'terminalWindowsShell',
  'terminalWindowsPowerShellImplementation'
])

export function retireAtRestCommandSettings(keys: Iterable<string>): void {
  if ([...keys].some((key) => launchSettings.has(key))) {
    retireAtRestCommandContext()
  }
}

export function retireAtRestCommandContext(workspaceId?: string): void {
  listeners.forEach((listener) => listener(workspaceId))
}

export function bindAtRestCommandContexts(
  sources: readonly (StructuredAgentSessionAtRestCommands | undefined)[]
): () => void {
  const retire = (workspaceId?: string): void =>
    sources.forEach((source) => source?.retireContext?.(workspaceId))
  listeners.add(retire)
  return () => {
    listeners.delete(retire)
    sources.forEach((source) => source?.dispose?.())
  }
}

export const atRestCommandContextReady = (): Promise<void> | undefined => readiness

export async function refreshAtRestCommandContext<T>(operation: () => Promise<T>): Promise<T> {
  const previous = readiness
  const completion = Promise.withResolvers<void>()
  readiness = completion.promise
  retireAtRestCommandContext()
  try {
    await previous
    return await operation()
  } finally {
    if (readiness === completion.promise) {
      readiness = undefined
    }
    completion.resolve()
  }
}
