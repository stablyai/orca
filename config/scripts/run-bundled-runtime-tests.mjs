import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildCliRuntime } from './build-cli-runtime.mjs'
import { cliRuntimeFilename } from '../bundled-cli-runtime.cjs'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
await buildCliRuntime(process.platform, process.arch)
const runtime = join(
  root,
  'out/cli-runtime',
  `${process.platform}-${process.arch}`,
  cliRuntimeFilename(process.platform)
)
const env = {
  ...process.env,
  ORCA_BACKGROUND_LAUNCH: '1',
  BUN_EXECUTABLE: runtime,
  ORCA_TEST_REQUIRE_CLI_ARTIFACTS: '1'
}
function run(args, environment = env) {
  const result = runProcessSync({
    program: process.execPath,
    args,
    cwd: root,
    env: environment,
    stdio: 'inherit',
    timeoutMs: 180_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Bundled runtime verification failed: ${result.code}`)
  }
}
run(['config/scripts/build-relay.mjs'])
run([
  'node_modules/typescript/bin/tsc',
  '-p',
  'config/tsconfig.cli.json',
  '--outDir',
  'out',
  '--composite',
  'false',
  '--incremental',
  'false'
])
run(['config/scripts/build-cli-bin.mjs'])
run([
  'node_modules/vitest/vitest.mjs',
  'run',
  '--config',
  'config/vitest.config.ts',
  // Cold PowerShell and native launcher compilation must not starve unrelated lifecycle probes.
  ...(process.platform === 'win32' ? ['--no-file-parallelism'] : []),
  'src/relay/bun-relay-artifact.integration.test.ts',
  'src/shared/child-process/fork-process-bun.integration.test.ts',
  'src/shared/bun-owned-runtime-args.integration.test.ts',
  'src/main/providers/windows-bun-console.integration.test.ts',
  'src/relay/ai-vault-memory-monitor.integration.test.ts',
  'src/main/ai-vault-search/session-search-bun.integration.test.ts',
  'src/main/ssh/ssh-relay-bun-runtime-commands.test.ts',
  'src/main/agent-hooks/wsl-hook-relay-live.integration.test.ts',
  'src/main/native-chat/wsl-transcript-bun.integration.test.ts',
  'src/main/browser/wsl-browser-network-bun.integration.test.ts',
  'src/main/cli/windows-cli-bun.integration.test.ts',
  'src/cli/cli-bun-runtime.integration.test.ts',
  'src/cli/runtime/cli-bun-environment.integration.test.ts',
  'src/shared/child-process/fork-process-bun.integration.test.ts',
  'src/shared/bun-owned-runtime-args.integration.test.ts',
  'src/cli/runtime/serve-bun-ipc.integration.test.ts',
  'src/cli/cli-bin.integration.test.ts',
  'src/cli/cli-bin-signals.integration.test.ts',
  'config/scripts/orca-dev-bin.test.mjs'
])

// Fresh profiles can prompt for Keychain access on a developer's Mac; use disposable CI hosts.
const macosAcceptance = process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true'
if (process.platform === 'linux' || process.platform === 'win32' || macosAcceptance) {
  run(['config/scripts/build-orcad-bun.mjs'])

  const home = mkdtempSync(join(tmpdir(), 'orca-runtime-acceptance-'))
  try {
    const isolated = Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith('ORCA_'))
    )
    for (const workspaceFlags of [[], ['--folder']]) {
      run(
        [
          'config/scripts/runtime-serve-terminal-smoke.mjs',
          '--target',
          'orcad',
          '--restart',
          ...workspaceFlags
        ],
        {
          ...isolated,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local/share'),
          ORCA_BACKGROUND_LAUNCH: '1'
        }
      )
    }
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
