import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const REPO_FLAGS = [...GLOBAL_FLAGS, 'repo']
const REPO_NOTE =
  'Uses the Azure DevOps organization of --repo (id:<id>, name:<name> or path:<path>), or of the Orca workspace the command runs in. PR ids are unique per organization.'

export const AZURE_DEVOPS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['azure-devops', 'pr', 'list'],
    summary: 'List pull requests waiting for your review, or the active ones for a branch',
    usage: 'orca azure-devops pr list [--branch <name>] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'branch'],
    notes: [
      REPO_NOTE,
      'Without --branch: active, non-draft PRs across the organization where you are a reviewer, with your vote.',
      'With --branch: active PRs from that source branch in the repo; completed ones are never reported.'
    ],
    examples: [
      'orca azure-devops pr list --json',
      'orca azure-devops pr list --branch feature/login'
    ]
  },
  {
    path: ['azure-devops', 'pr', 'show'],
    summary: 'Read a pull request: description, reviewers and votes, merge state, iterations',
    usage: 'orca azure-devops pr show <id> [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [REPO_NOTE]
  },
  {
    path: ['azure-devops', 'pr', 'threads'],
    summary: "List a pull request's discussion threads with file and line",
    usage: 'orca azure-devops pr threads <id> [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [REPO_NOTE, 'System threads (votes, pushes, policy notes) are left out.']
  },
  {
    path: ['azure-devops', 'pr', 'checks'],
    summary: "List a pull request's branch policies, builds and statuses",
    usage: 'orca azure-devops pr checks <id> [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [REPO_NOTE]
  },
  {
    path: ['azure-devops', 'pr', 'files'],
    summary: 'List files changed in the latest iteration, optionally since an earlier one',
    usage: 'orca azure-devops pr files <id> [--since-iteration <n>] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id', 'since-iteration'],
    positionalArgs: ['id'],
    notes: [
      REPO_NOTE,
      'Reports base and head commits; after `git fetch origin <head>`, `git diff <base> <head> -- <path>` shows the change.'
    ],
    examples: ['orca azure-devops pr files 4321 --since-iteration 2 --json']
  },
  {
    path: ['azure-devops', 'pr', 'build'],
    summary: "Read a PR build's steps, and the tail of its failed task logs",
    usage:
      'orca azure-devops pr build <id> --build <buildId> [--log] [--tail <n>] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id', 'build', 'log', 'tail'],
    booleanFlags: ['log'],
    positionalArgs: ['id'],
    notes: [
      REPO_NOTE,
      'Take <buildId> from `pr checks`. --log adds the last --tail lines (default 150, at most 1000) of up to three failed tasks.'
    ],
    examples: ['orca azure-devops pr build 4321 --build 9876 --log --json']
  },
  {
    path: ['azure-devops', 'pr', 'comment'],
    summary: 'Post a comment on a pull request (needs --confirm)',
    usage:
      'orca azure-devops pr comment <id> --body <text> [--thread <threadId> | --file <path> [--line <n>]] [--confirm] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id', 'body', 'thread', 'file', 'line', 'confirm'],
    booleanFlags: ['confirm'],
    positionalArgs: ['id'],
    notes: [
      REPO_NOTE,
      'Without --confirm, prints what it would post and posts nothing. Pass --confirm only after the user approved this exact text.',
      'At most 20 comments a day go through Orca; --thread replies in an existing thread, --file/--line opens one on the PR version of that file.'
    ]
  },
  {
    path: ['azure-devops', 'pr', 'vote'],
    summary: 'Set your vote on a pull request (needs --confirm)',
    usage:
      'orca azure-devops pr vote <id> --vote approve|approve-with-suggestions|wait-for-author|reset [--confirm] [--repo <selector>] [--json]',
    allowedFlags: [...REPO_FLAGS, 'id', 'vote', 'confirm'],
    booleanFlags: ['confirm'],
    positionalArgs: ['id'],
    notes: [
      REPO_NOTE,
      'Without --confirm, prints the vote it would set and changes nothing. Pass --confirm only after the user approved this vote.',
      'Reject is not available: problems belong in comments. At most 5 votes a day go through Orca.'
    ]
  }
]
