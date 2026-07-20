#!/usr/bin/env node
/**
 * Bundle the relay daemon and its crash-isolated watcher child per platform.
 *
 * The relay runs on remote hosts via `node relay.js`, so both outputs use
 * self-contained CommonJS bundles with no external dependencies beyond
 * Node.js built-ins. Native addons (node-pty, @parcel/watcher) are
 * marked external and expected to be installed on the remote or
 * gracefully degraded.
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const __dirname = import.meta.dirname
// Why: the script lives under config/scripts, so go two levels up to reach the repo root.
const ROOT = join(__dirname, '..', '..')
const RELAY_ENTRY = join(ROOT, 'src', 'relay', 'relay.ts')
const WATCHER_ENTRY = join(ROOT, 'src', 'main', 'ipc', 'parcel-watcher-process-entry.ts')
const MANAGED_HOOK_RUNTIME_ENTRY = join(
  ROOT,
  'src',
  'main',
  'agent-hooks',
  'managed-hook-runtime.ts'
)
const JSONC_PARSER_ESM_ENTRY = join(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js')

const PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
]

const RELAY_VERSION = '0.1.0'

for (const platform of PLATFORMS) {
  const outDir = join(ROOT, 'out', 'relay', platform)
  mkdirSync(outDir, { recursive: true })

  await build({
    entryPoints: [RELAY_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outDir, 'relay.js'),
    // Native addons cannot be bundled — they must exist on the remote host.
    // The relay gracefully degrades when they are absent.
    external: ['node-pty', '@parcel/watcher', 'electron'],
    sourcemap: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  })

  await build({
    entryPoints: [WATCHER_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outDir, 'relay-watcher.js'),
    external: ['@parcel/watcher'],
    sourcemap: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  })

  await build({
    entryPoints: [MANAGED_HOOK_RUNTIME_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outDir, 'managed-hook-runtime.js'),
    // Why: jsonc-parser's default UMD build keeps relative dynamic requires
    // that break after bundling; its ESM entry is equivalent and self-contained.
    alias: { 'jsonc-parser': JSONC_PARSER_ESM_ENTRY },
    sourcemap: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  })

  // Why: include a content hash so the deploy check detects code changes
  // even when RELAY_VERSION hasn't been bumped. Hash every executable module
  // so a companion-only change always deploys beside the matching relay host.
  const relayContent = readFileSync(join(outDir, 'relay.js'))
  const watcherContent = readFileSync(join(outDir, 'relay-watcher.js'))
  const managedHookRuntimeContent = readFileSync(join(outDir, 'managed-hook-runtime.js'))
  const hash = createHash('sha256')
    .update(relayContent)
    .update(watcherContent)
    .update(managedHookRuntimeContent)
    .digest('hex')
    .slice(0, 12)
  writeFileSync(join(outDir, '.version'), `${RELAY_VERSION}+${hash}`)

  console.log(`Built relay for ${platform} → ${outDir}/relay.js`)
}

// WSL agent-hook relay: a hooks-only guest receiver launched inside WSL
// distros via wsl.exe. Pure Node built-ins (no node-pty/@parcel/watcher),
// so a single platform-independent bundle suffices; it ships inside the
// Windows app via the same out/relay extraResources mapping.
{
  const wslEntry = join(ROOT, 'src', 'relay', 'wsl-agent-hook-relay.ts')
  const outDir = join(ROOT, 'out', 'relay', 'wsl')
  mkdirSync(outDir, { recursive: true })
  await build({
    entryPoints: [wslEntry],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outDir, 'wsl-agent-hook-relay.js'),
    sourcemap: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  })
  const content = readFileSync(join(outDir, 'wsl-agent-hook-relay.js'))
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12)
  writeFileSync(join(outDir, '.version'), `${RELAY_VERSION}+${hash}`)
  console.log(`Built WSL hook relay → ${outDir}/wsl-agent-hook-relay.js`)
}

console.log('Relay build complete.')
