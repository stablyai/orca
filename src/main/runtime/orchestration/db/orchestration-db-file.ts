import { join } from 'node:path'

/** The desktop's orchestration database inside a profile's userData directory. */
export function orchestrationDbFile(userDataPath: string): string {
  return join(userDataPath, 'orchestration.db')
}

const replacedAtQuit = new Set<string>()

/** From the start of the quit swap: nothing in this process may write the file again. */
export function refuseOrchestrationDbWritesForReplacement(databasePath: string): void {
  replacedAtQuit.add(databasePath)
}

export function isOrchestrationDbBeingReplaced(databasePath: string): boolean {
  return replacedAtQuit.has(databasePath)
}
