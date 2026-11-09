import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const ENV_NOTE =
  'With several environments in the org, pick one with --env <name|id>; without it the first one is used.'

export const CLOUD_ENV_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['cloud', 'env', 'show'],
    summary: 'Show the Orca Cloud environment: repos, install script, builds and freshness',
    usage: 'orca cloud env show [--env <name|id>] [--refresh] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'env', 'refresh'],
    notes: [
      'Needs the Orca desktop app signed in to Orca Cloud; the CLI asks it.',
      ENV_NOTE,
      '--refresh re-checks the repos on GitHub instead of using the minute-old answer.'
    ],
    examples: ['orca cloud env show', 'orca cloud env show --env web --json']
  },
  {
    path: ['cloud', 'env', 'set-install-script'],
    summary: 'Replace the environment install script with the contents of a file',
    usage: 'orca cloud env set-install-script --file <path|-> [--env <name|id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'env', 'file'],
    notes: [
      'The script is bash; each build runs it once with `set -euo pipefail` in the first repo, with passwordless sudo. The log’s first line names the base image and its package manager (currently Ubuntu with apt-get).',
      'Only the install script changes. Repos, secrets and machine size are edited in Settings by org owners and admins.',
      'Fails with "Someone else saved changes; reload." when the environment changed since it was read.',
      ENV_NOTE
    ],
    examples: [
      'orca cloud env set-install-script --file /tmp/install.sh',
      'cat install.sh | orca cloud env set-install-script --file -'
    ]
  },
  {
    path: ['cloud', 'env', 'build'],
    summary: 'Start a build of the environment, optionally waiting for it and streaming its log',
    usage: 'orca cloud env build [--wait] [--env <name|id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'env', 'wait'],
    notes: [
      'A build boots a VM, clones the repos, runs the install script and snapshots the result. A succeeded build becomes the active one new workspaces start from.',
      '--wait streams the log to stdout/stderr and exits 1 unless the build succeeds, printing the failed step and error. With --json it prints the final build and the end of the log instead.',
      'Interrupting --wait leaves the build running; follow it again with `orca cloud env logs <number>`.',
      ENV_NOTE
    ],
    examples: ['orca cloud env build --wait', 'orca cloud env build --wait --json']
  },
  {
    path: ['cloud', 'env', 'builds'],
    summary: 'List the environment’s recent builds, newest first',
    usage: 'orca cloud env builds [--env <name|id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'env'],
    notes: [ENV_NOTE],
    examples: ['orca cloud env builds', 'orca cloud env builds --json']
  },
  {
    path: ['cloud', 'env', 'logs'],
    summary: 'Print a build’s log, following it until the build finishes',
    usage: 'orca cloud env logs <build-number|build-id> [--env <name|id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'env', 'build'],
    positionalArgs: ['build'],
    notes: [
      'Lines starting with `::orca-step::` mark build steps; `::orca-error::` lines are Orca’s explanation of a failure.',
      ENV_NOTE
    ],
    examples: ['orca cloud env logs 12', 'orca cloud env logs bld_0123456789abcdef']
  }
]
