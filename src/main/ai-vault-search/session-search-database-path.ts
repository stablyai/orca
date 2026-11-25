import { join } from 'node:path'

/** One index per execution host’s data root; the scanner child is its sole writer. */
export function sessionSearchDatabasePath(dataRoot: string): string {
  return join(dataRoot, 'ai-vault', 'session-search.sqlite')
}
