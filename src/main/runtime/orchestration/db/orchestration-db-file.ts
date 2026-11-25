import { join } from 'node:path'

/** The desktop's orchestration database inside a profile's userData directory. */
export function orchestrationDbFile(userDataPath: string): string {
  return join(userDataPath, 'orchestration.db')
}
