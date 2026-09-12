import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { RuntimeTerminalCreate, RuntimeTerminalPresentation } from '../../shared/runtime-types'
import { createTerminalRevealWarning } from './orca-runtime-core'

export async function revealCreatedTerminal(
  notifier: RuntimeNotifier | null | undefined,
  presentation: RuntimeTerminalPresentation | undefined,
  worktreeId: string,
  handle: string,
  opts: Parameters<NonNullable<RuntimeNotifier['revealTerminalSession']>>[1]
): Promise<Pick<RuntimeTerminalCreate, 'surface' | 'warning'>> {
  if (presentation === 'background') {
    return { surface: 'background' }
  }
  if (!notifier?.revealTerminalSession) {
    return { surface: 'background', warning: createTerminalRevealWarning(handle) }
  }
  try {
    await notifier.revealTerminalSession(worktreeId, opts)
    return { surface: 'visible' }
  } catch (error) {
    console.warn(`[terminal-create] failed to create inactive tab for ${opts.ptyId}:`, error)
    return { surface: 'background', warning: createTerminalRevealWarning(handle, error) }
  }
}
