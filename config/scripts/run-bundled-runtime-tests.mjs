import { join, resolve } from 'node:path'
import { currentTarget, materializeRuntime } from './build-orcad-bun.mjs'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const target = currentTarget()
const runtime = join(root, 'out/.bundled-runtime-tests', target, orcadBunRuntimeFilename(target))
await materializeRuntime(target, runtime)
const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', BUN_EXECUTABLE: runtime }
function run(args) {
  const result = runProcessSync({
    program: process.execPath,
    args,
    cwd: root,
    env,
    stdio: 'inherit',
    timeoutMs: 180_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Bundled runtime verification failed: ${result.code}`)
  }
}
run(['config/scripts/build-relay.mjs'])
run([
  'node_modules/vitest/vitest.mjs',
  'run',
  '--config',
  'config/vitest.config.ts',
  // Cold PowerShell and native launcher compilation must not starve unrelated lifecycle probes.
  ...(process.platform === 'win32' ? ['--no-file-parallelism'] : []),
  'src/relay/bun-relay-artifact.integration.test.ts',
  'src/main/providers/windows-bun-console.integration.test.ts',
  'src/relay/ai-vault-memory-monitor.integration.test.ts',
  'src/main/ai-vault-search/session-search-bun.integration.test.ts',
  'src/main/ssh/ssh-relay-bun-runtime-commands.test.ts',
  'src/main/native-chat/wsl-transcript-bun.integration.test.ts',
  'src/main/browser/wsl-browser-network-bun.integration.test.ts',
  'src/main/agent-hooks/wsl-hook-relay-live.integration.test.ts'
])
