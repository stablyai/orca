import {
  classifyGitCommand,
  findGitSubcommandIndex
} from '../../../shared/git/commands/git-command-classification'
import { beginGitRefMutation } from '../refs/git-ref-change-signal'

export function trackGitRefMutation(args: readonly string[]): () => void {
  if (classifyGitCommand(args) === 'read') {
    return () => {}
  }
  const index = findGitSubcommandIndex(args)
  const command = args[index]
  const flags = args.slice(index + 1)
  if (
    ['ls-remote', 'add', 'update-index', 'hash-object'].includes(command) ||
    (command === 'restore' && flags.includes('--staged')) ||
    (command === 'apply' && flags.includes('--cached')) ||
    (command === 'merge-tree' && flags.includes('--write-tree'))
  ) {
    return () => {}
  }
  return beginGitRefMutation(null)
}
