import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { runProcess } from '../../../src/shared/child-process/run-process'

const root = process.cwd()
const evidence = resolve('notes/search-ipc')
const overlay = join(evidence, 'overlay')
const wiring = '9845bef63a6'
const mode = process.argv[2]
assert.equal(process.platform, 'win32', 'This harness requires native Windows and NTFS')
assert.ok(mode === 'red' || mode === 'green', 'Pass red or green')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const output = join(evidence, mode, String(Date.now()))
await mkdir(output, { recursive: true })

async function command(program: string, args: string[]) {
  const result = await runProcess({ program, args, cwd: root, timeoutMs: 120_000 })
  assert.equal(result.code, 0, result.stderr)
  return result.stdout.trim()
}

// The overlay is exported, never checked out or staged on the fix branch.
await mkdir(overlay, { recursive: true })
await command('git', [
  'archive',
  '--format=tar',
  `--output=${join(evidence, 'overlay.tar')}`,
  wiring,
  'src'
])
await command('tar', [
  '-xf',
  relative(root, join(evidence, 'overlay.tar')),
  '-C',
  relative(root, overlay)
])
const edits: { path: string; sha256: string }[] = []
function replaceOnce(source: string, before: string, after: string) {
  assert.equal(source.split(before).length, 2, `Expected exactly one injection: ${before}`)
  return source.replace(before, after)
}

const adapter = join(output, 'adapter.mjs')
const source = (path: string) => JSON.stringify(join(overlay, 'src', path))
await writeFile(
  adapter,
  `
export { installChildSessionSearchService, applySessionSearchSettingsChange } from ${source('main/ai-vault-search/session-search-enablement.ts')};
export { resetAiVaultScannerServiceForTests, reconcileSessionSearchInService } from ${source('main/ai-vault/session-scanner-service-spawn.ts')};
export { setAppEnvironment } from ${source('shared/app-environment.ts')};
export { isolatedScanRoots } from ${source('main/ai-vault/session-scanner-test-fixtures.ts')};
export { claudeLines } from ${source('main/ai-vault-search/session-search-indexer-test-fixture.ts')};
export { runProcess } from ${source('shared/child-process/run-process.ts')};
export { UnixSocketTransport } from ${source('main/runtime/rpc/unix-socket-transport.ts')};
export { RpcDispatcher } from ${source('main/runtime/rpc/dispatcher.ts')};
export { AI_VAULT_METHODS } from ${source('main/runtime/rpc/methods/ai-vault.ts')};
import { buildRegistry } from ${source('main/runtime/rpc/core.ts')};
import { AI_VAULT_METHODS } from ${source('main/runtime/rpc/methods/ai-vault.ts')};
const registry = buildRegistry(AI_VAULT_METHODS);
export async function rpc(name, params) {
  const method = registry.get(name);
  if (!method || !name.startsWith('aiVault.search')) throw new Error('Unexpected method');
  return method.handler(method.params.parse(params), {});
}
`
)

await build({
  entryPoints: {
    production: adapter,
    'session-scanner-service-entry': join(
      overlay,
      'src/main/ai-vault/session-scanner-service-entry.ts'
    )
  },
  outdir: output,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  packages: 'external',
  define: { ORCA_FEATURE_WALL_ENABLED: 'true' },
  plugins: [
    {
      name: 'labelled-local-fixtures',
      setup(api) {
        api.onLoad({ filter: /\.ts$/ }, async (args) => {
          let contents = await readFile(args.path, 'utf8')
          const path = args.path.replaceAll('\\', '/')
          if (path.endsWith('/runtime/rpc/methods/index.ts')) {
            // DispatcherOptions explicitly supplies AI_VAULT_METHODS; don't load unrelated default methods.
            contents = 'export const ALL_RPC_METHODS = []'
          }
          if (path.endsWith('/cached-session-list.ts')) {
            contents = replaceOnce(
              contents,
              '  const [additionalCodexHomes, wslHomeDirs] = await Promise.all([',
              '  return JSON.parse(process.env.ORCA_FILE_ID_ROOTS!);\n  const [additionalCodexHomes, wslHomeDirs] = await Promise.all(['
            )
          }
          if (path.endsWith('/session-scanner-service-env.ts')) {
            contents = replaceOnce(
              contents,
              "  env.ELECTRON_RUN_AS_NODE = '1'",
              "  env.ORCA_BACKGROUND_LAUNCH = '1'\n  env.ELECTRON_RUN_AS_NODE = '1'"
            )
          }
          if (path.endsWith('/session-scanner-service-spawn.ts')) {
            contents = replaceOnce(
              contents,
              '  lowerAiVaultServicePriority(child.pid)',
              '  globalThis.__fileIdObserveChild?.(child)\n  lowerAiVaultServicePriority(child.pid)'
            )
          }
          if (path.endsWith('/session-scanner-service-entry.ts')) {
            contents = `import { registerTranscriptConsumer } from './session-transcript-consumers';
registerTranscriptConsumer({beginRead: start => { console.error('[file-id-read]', JSON.stringify({mode:start.mode,path:start.candidate.file.path})); return null }});
console.error('[file-id-child]', JSON.stringify({pid:process.pid,execPath:process.execPath,versions:process.versions,background:process.env.ORCA_BACKGROUND_LAUNCH}));\n${contents}`
          }
          if (mode === 'green' && path.endsWith('/session-search-store.ts')) {
            contents = replaceOnce(
              contents,
              'SELECT path, dev, ino, mtime_ms',
              'SELECT path, CAST(dev AS REAL) AS dev, CAST(ino AS REAL) AS ino, mtime_ms'
            )
          }
          if (mode === 'green' && path.endsWith('/session-search-index-writer.ts')) {
            contents = replaceOnce(
              contents,
              'SELECT dev, ino, byte_offset',
              'SELECT CAST(dev AS REAL) AS dev, CAST(ino AS REAL) AS ino, byte_offset'
            )
          }
          edits.push({
            path: path.replace(overlay.replaceAll('\\', '/'), ''),
            sha256: createHash('sha256').update(contents).digest('hex')
          })
          return { contents, loader: 'ts' }
        })
      }
    }
  ]
})
await copyFile(
  join(root, 'config/scripts/session-search-file-id-e2e/host.cjs'),
  join(output, 'host.cjs')
)
await copyFile(
  join(root, 'config/scripts/session-search-file-id-e2e/client.cjs'),
  join(output, 'client.cjs')
)
await writeFile(
  join(output, 'topology.json'),
  JSON.stringify(
    {
      wiring: await command('git', ['rev-parse', wiring]),
      fix: await command('git', ['rev-parse', 'HEAD']),
      mode,
      injections: [
        'isolated root resolver',
        'background child env',
        'child PID/error/read observation',
        'unused default RPC catalog excluded; explicit production AI_VAULT_METHODS'
      ],
      files: edits.sort((a, b) => a.path.localeCompare(b.path))
    },
    null,
    2
  )
)
await writeFile(join(evidence, `${mode}-latest.json`), JSON.stringify({ output }))
for (const phase of ['lifecycle', 'restart']) {
  console.log(JSON.stringify({ mode, phase, output }))
  const result = await runProcess({
    program: join(root, 'node_modules/electron/dist/electron.exe'),
    args: [join(output, 'host.cjs'), output, phase],
    cwd: output,
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      ORCA_FILE_ID_NODE: process.execPath
    },
    timeoutMs: 180_000
  })
  await writeFile(join(output, `process-${phase}.log`), result.stdout + result.stderr)
  console.log(JSON.stringify({ mode, phase, code: result.code, timedOut: result.timedOut, output }))
  process.exitCode = result.code ?? 1
  if (process.exitCode !== 0) {
    break
  }
}
