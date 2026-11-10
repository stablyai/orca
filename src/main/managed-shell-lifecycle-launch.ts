import { randomUUID } from 'node:crypto'
import { SHELL_LIFECYCLE_STATE_ENV } from './managed-shell-lifecycle-state-file'
import { basename } from 'node:path'
import { SHELL_LIFECYCLE_BINDING_ENV } from './managed-shell-lifecycle'

export function prepareManagedShellLifecycle(
  env: Record<string, string>,
  shellPath: string,
  args: string[],
  generatedArgs?: string[] | null
): void {
  delete env[SHELL_LIFECYCLE_BINDING_ENV]
  delete env[SHELL_LIFECYCLE_STATE_ENV]
  if (
    process.platform !== 'win32' &&
    basename(shellPath) === 'bash' &&
    args === generatedArgs &&
    args[0] === '--rcfile'
  ) {
    env[SHELL_LIFECYCLE_BINDING_ENV] = randomUUID()
  }
}
