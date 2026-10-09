import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import {
  BACKLOG_CLI_VERSION,
  type BacklogOperation,
  type BacklogTask
} from '../../shared/backlog-types'
import { runProcess } from '../../shared/child-process/run-process'
import { readBacklogFile, type BacklogProject } from './backlog-project'

const Package = z.object({
  name: z.literal('backlog.md'),
  version: z.literal(BACKLOG_CLI_VERSION),
  bin: z.object({ backlog: z.literal('cli.js') })
})
const INSTALL_MESSAGE = `Install backlog.md@${BACKLOG_CLI_VERSION} as a pinned dependency in this project on its execution host. Orca never downloads a CLI automatically.`

/** Requires the pinned CLI inside this checkout; never searches PATH or installs packages. */
export async function resolveBacklogCli(project: BacklogProject): Promise<string> {
  try {
    const packageDir = await realpath(path.join(project.root, 'node_modules', 'backlog.md'))
    const relative = path.relative(project.root, packageDir)
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('CLI outside project')
    }
    Package.parse(JSON.parse(await readBacklogFile(path.join(packageDir, 'package.json'), 32768)))
    const cli = await realpath(path.join(packageDir, 'cli.js'))
    if (path.dirname(cli) !== packageDir) {
      throw new Error('CLI outside package')
    }
    return cli
  } catch {
    throw new Error(INSTALL_MESSAGE)
  }
}

/** Returns the configuration reason edits are blocked, or null; does not check CLI availability. */
export function backlogMutationUnavailable(project: BacklogProject): string | null {
  const config = project.config
  if (!project.configMatchesCli) {
    return 'Normalize this project configuration with the Backlog CLI before editing in Orca.'
  }
  if (
    project.unsafeCliConfig ||
    config.auto_commit ||
    config.autoCommit ||
    config.onStatusChange ||
    config.on_status_change
  ) {
    return 'Disable Backlog autoCommit and onStatusChange before editing in Orca, or use the Backlog CLI directly.'
  }
  if (config.remote_operations !== false || config.check_active_branches !== false) {
    return 'Set Backlog remoteOperations and checkActiveBranches to false before editing in Orca to keep task operations local to this checkout.'
  }
  return null
}

/** Emits only changed edit fields and separates user text from CLI option parsing. */
export function backlogMutationArgs(
  operation: Extract<BacklogOperation, { kind: 'create' | 'edit' }>,
  previous?: BacklogTask | null
): string[] {
  const fields = (['title', 'description', 'status'] as const)
    .filter((field) => !previous || operation[field] !== previous[field])
    .map((field) => `--${field}=${operation[field]}`)
  return operation.kind === 'edit'
    ? ['task', 'edit', operation.id, ...fields, '--plain']
    : ['task', 'create', ...fields.slice(1), '--plain', '--', operation.title]
}

/** Runs the pinned CLI with bounded time/output; failures leave completion unconfirmed, not rolled back. */
export async function runBacklogMutation(
  project: BacklogProject,
  operation: Extract<BacklogOperation, { kind: 'create' | 'edit' }>,
  previous: BacklogTask | null,
  signal: AbortSignal
): Promise<void> {
  const cli = await resolveBacklogCli(project)
  signal.throwIfAborted()
  const result = await runProcess({
    signal,
    program: process.execPath,
    args: [cli, ...backlogMutationArgs(operation, previous)],
    cwd: project.root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BACKLOG_CWD: project.root,
      CI: '1',
      NO_COLOR: '1',
      GIT_TERMINAL_PROMPT: '0'
    },
    timeoutMs: 30000,
    maxOutputBytes: 262144,
    killOnOutputLimit: true,
    detached: process.platform !== 'win32',
    terminationBarrier: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(
      `Backlog CLI did not confirm completion. Refresh tasks before retrying. ${result.stderr.slice(0, 2000)}`
    )
  }
}
