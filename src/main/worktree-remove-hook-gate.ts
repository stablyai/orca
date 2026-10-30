import type { Repo } from '../shared/repo-types'
import type { HookRuntimeTarget } from './hook-runtime-target'
import { getEffectiveHooks, runHook } from './hooks'
import { createHash } from 'node:crypto'

export function assertUnregisteredRemovalHasNoRequiredHook(repo: Repo): void {
  if (getEffectiveHooks(repo, undefined, { strictRemoval: true })?.scripts.remove) {
    throw new Error(
      'This directory has a required removal script but is no longer a registered Git worktree. Restore its Git registration and retry; the directory and retained resources were left in place.'
    )
  }
}

export function getWorktreeRemoveHookReview(repo: Repo): {
  script: string
  removeHookHash: string
  commands: readonly string[]
} {
  const hooks = getEffectiveHooks(repo, undefined, { strictRemoval: true })
  const configured = hooks?.scripts.remove?.trim()
  const commands = configured ? (hooks?.removeCommands ?? [configured]) : []
  const script =
    commands.length > 1
      ? commands
          .map(
            (command, index) => `# ${index === 0 ? 'Shared' : 'Local'} removal script\n${command}`
          )
          .join('\n\n')
      : (commands[0] ?? '')
  return {
    script,
    commands,
    removeHookHash: createHash('sha256').update(JSON.stringify(commands)).digest('hex')
  }
}

export function assertWorktreeRemoveHookApproval(
  repo: Repo,
  expectedHash?: string
): readonly string[] {
  const { script, commands, removeHookHash: contentHash } = getWorktreeRemoveHookReview(repo)
  if (script && expectedHash === undefined) {
    throw Object.assign(
      new Error(
        'Permanent removal requires review of this removal script, which may delete associated resources and retained data. ' +
          `Review the script, then repeat with --remove-hook-hash ${contentHash}.\n${script}`
      ),
      {
        code: 'worktree_remove_hook_confirmation_required',
        data: { script, removeHookHash: contentHash }
      }
    )
  }
  if (expectedHash !== undefined && contentHash !== expectedHash) {
    throw Object.assign(
      new Error('The removal script changed. Review the current removal action and retry.'),
      {
        code: 'worktree_remove_hook_changed'
      }
    )
  }
  return commands
}

/** A required removal script owns disposal; archive waivers cannot authorize skipping it. */
export async function runRequiredWorktreeRemoveHook(
  repo: Repo,
  worktreePath: string,
  runtime?: HookRuntimeTarget,
  expectedHash?: string
): Promise<void> {
  const commands = assertWorktreeRemoveHookApproval(repo, expectedHash)
  for (const script of commands) {
    const result = await runHook(
      'remove',
      worktreePath,
      repo,
      undefined,
      runtime,
      undefined,
      script
    )
    if (result.success) {
      continue
    }
    const verdict =
      typeof result.exitCode === 'number'
        ? `exited ${result.exitCode}`
        : 'completion could not be verified'
    throw Object.assign(
      new Error(
        `Remove hook failed for worktree: ${worktreePath} — ${verdict}. The checkout was retained. Cleanup may be incomplete; fix the removal script and retry. ${result.output.trim()}`
      ),
      {
        code: 'worktree_remove_hook_failed',
        data: { worktreePath, ...result }
      }
    )
  }
}
