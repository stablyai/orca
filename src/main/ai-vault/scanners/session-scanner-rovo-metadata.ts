import { firstString } from '../session-scanner-values'

/** Scope discovery reads cwd from metadata without opening the context file. */
export function rovoSessionCwd(metadata: Record<string, unknown>): string | null {
  return firstString(metadata, [
    'workspace_path',
    'workspacePath',
    'workspace',
    'cwd',
    'working_directory',
    'workingDirectory',
    'project_path',
    'projectPath'
  ])
}

export function rovoRoleFromKind(value: unknown): 'user' | 'assistant' | null {
  if (value === 'request') {
    return 'user'
  }
  if (value === 'response') {
    return 'assistant'
  }
  return null
}
