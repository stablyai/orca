import { getOptionalClickUpTaskLinkFlag } from './worktree-clickup-task-link'
import { getOptionalLinearIssueLinkFlag } from './worktree-linear-issue-link'

// Why: create and set accept the same task-tracker link flags; reading them in
// one place keeps both handlers in step as providers are added.
export function getOptionalTaskLinkFlags(
  flags: Map<string, string | boolean>,
  options: { allowNull?: boolean } = {}
) {
  return {
    ...getOptionalLinearIssueLinkFlag(flags, 'linear-issue', options),
    ...getOptionalClickUpTaskLinkFlag(flags, options)
  }
}
