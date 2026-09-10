import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '0' }
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function requirePython() {
  const executable = ['python3', 'python'].find((command) => {
    const result = spawnSync(command, ['--version'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'ignore'
    })
    return !result.error && result.status === 0
  })
  if (!executable) {
    throw new Error('Python 3 is required for the Maestro CLI subprocess check.')
  }
}

requirePython()

run('pnpm', ['run', 'build:cli'])

const cliPath = resolve(root, 'out/cli/index.js')
if (!existsSync(cliPath)) {
  throw new Error(`Built CLI is missing: ${cliPath}`)
}

run('pnpm', [
  'exec',
  'vitest',
  'run',
  '--config',
  'config/vitest.config.ts',
  'src/shared/tui-agent-permissions.test.ts',
  'src/shared/managed-cli-context.test.ts',
  'src/shared/workspace-bootstrap-receipt.test.ts',
  'src/main/runtime/rpc/methods/workspace-bootstrap-receipt.test.ts',
  'src/main/runtime/rpc/methods/orchestration-worker-launch-preferences.test.ts',
  'src/main/runtime/orchestration/cli-command.test.ts',
  'src/main/runtime/orchestration/preamble.test.ts',
  'src/main/runtime/orchestration/coordinator.test.ts',
  'src/main/runtime/rpc/methods/orchestration-federation.test.ts',
  'src/main/runtime/rpc/methods/orchestration-workers-new-worktree.test.ts',
  'src/main/runtime/rpc/methods/orchestration-composed-workers.test.ts',
  'src/main/providers/ssh-pty-provider-spawn.test.ts',
  'src/main/ssh/ssh-relay-session.test.ts',
  'src/main/runtime/orchestration-cli-subprocess.test.ts'
])

// Why: orca-runtime.test.ts is a ~43k-line suite — running it whole here would
// blow the Check's bound. A precise -t pattern proves the real
// ptyController.spawn boundary (managed-launch injection + manual
// non-injection) without dragging in the rest of the file.
run('pnpm', [
  'exec',
  'vitest',
  'run',
  '--config',
  'config/vitest.config.ts',
  'src/main/runtime/orca-runtime.test.ts',
  '-t',
  'injects the exact bounded ManagedCliContext into the spawned env for an orchestration-managed launch|never injects a ManagedCliContext into the spawned env for an ordinary manual terminal|overwrites a caller-forged ORCA_MANAGED_CLI_\\* env key with the authoritative object on a managed launch|strips a caller-forged ORCA_MANAGED_CLI_\\* env key instead of letting it reach spawn on a manual terminal'
])
