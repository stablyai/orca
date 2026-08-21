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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  RELAY_BUILD_PLATFORMS,
  RELAY_VERSION_FILENAME,
  isWindowsRelayPlatform,
  relayArtifactFilenames
} from '../../src/shared/relay-artifacts.ts'

const __dirname = import.meta.dirname
// Why: the script lives under config/scripts, so go two levels up to reach the repo root.
const ROOT = join(__dirname, '..', '..')
const RELAY_ENTRY = join(ROOT, 'src', 'relay', 'relay.ts')
const WATCHER_ENTRY = join(ROOT, 'src', 'main', 'ipc', 'parcel-watcher-process-entry.ts')
const AI_VAULT_SERVICE_ENTRY = join(ROOT, 'src', 'relay', 'ai-vault-service-entry.ts')
const WSL_TRANSCRIPT_FS_PROCESS_ENTRY = join(
  ROOT,
  'src',
  'main',
  'native-chat',
  'wsl-transcript-fs-process-entry.ts'
)
const MANAGED_HOOK_RUNTIME_ENTRY = join(
  ROOT,
  'src',
  'main',
  'agent-hooks',
  'managed-hook-runtime.ts'
)
const JSONC_PARSER_ESM_ENTRY = join(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js')
const NODE_PTY_CONSOLE_LIST_PATCH_FILENAME = 'node-pty-1.1.0-console-list-agent-patch.cjs'
const NODE_PTY_CONSOLE_LIST_PATCH_SOURCE = join(
  ROOT,
  'config',
  'relay-assets',
  NODE_PTY_CONSOLE_LIST_PATCH_FILENAME
)

// Why: lets the packaging contract test build into a temp tree instead of
// clobbering a developer's out/relay or racing tests that read it.
const OUT_ROOT = process.env.ORCA_RELAY_OUT_ROOT ?? join(ROOT, 'out', 'relay')

const RELAY_VERSION = '0.1.0'

for (const platform of RELAY_BUILD_PLATFORMS) {
  const outDir = join(OUT_ROOT, platform)
  // Why: a stale companion left by an earlier build would otherwise satisfy the
  // manifest check and be hashed into .version, shipping mixed-generation bytes.
  rmSync(outDir, { recursive: true, force: true })
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

  if (isWindowsRelayPlatform(platform)) {
    copyFileSync(
      NODE_PTY_CONSOLE_LIST_PATCH_SOURCE,
      join(outDir, NODE_PTY_CONSOLE_LIST_PATCH_FILENAME)
    )
  }

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
    entryPoints: [AI_VAULT_SERVICE_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outDir, 'relay-ai-vault-service.js'),
    external: ['electron'],
    sourcemap: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  })

  // Why beside the service: the spawn resolves this child next to its own
  // bundle, and a relay host has no desktop out/main to fall back to.
  await build({
    entryPoints: [WSL_TRANSCRIPT_FS_PROCESS_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outDir, 'wsl-transcript-fs-process-entry.js'),
    external: ['electron'],
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

  // Why: include a content hash so the deploy check detects code changes even
  // when RELAY_VERSION hasn't been bumped. Hashing the whole manifest means a
  // companion-only change still selects a fresh immutable relay directory.
  const expected = relayArtifactFilenames(isWindowsRelayPlatform(platform))
  const hash = createHash('sha256')
  for (const filename of expected) {
    const artifactPath = join(outDir, filename)
    if (!existsSync(artifactPath)) {
      throw new Error(
        `Relay ${platform} declares ${filename} in RELAY_ARTIFACTS but never emitted it. ` +
          'Add the build step, or drop it from src/shared/relay-artifacts.ts.'
      )
    }
    hash.update(readFileSync(artifactPath))
  }
  const contentHash = hash.digest('hex').slice(0, 12)

  // Close the loop: an artifact emitted here but absent from the manifest would
  // ship unhashed and unprobed — exactly how the WSL helper went missing.
  const emitted = readdirSync(outDir).filter((name) => name !== RELAY_VERSION_FILENAME)
  const undeclared = emitted.filter((name) => !expected.includes(name))
  if (undeclared.length > 0) {
    throw new Error(
      `Relay ${platform} emitted undeclared artifacts: ${undeclared.join(', ')}. ` +
        'Add them to RELAY_ARTIFACTS in src/shared/relay-artifacts.ts.'
    )
  }
  writeFileSync(join(outDir, RELAY_VERSION_FILENAME), `${RELAY_VERSION}+${contentHash}`)

  console.log(`Built relay for ${platform} → ${outDir}/relay.js`)
}

// WSL agent-hook relay: a hooks-only guest receiver launched inside WSL
// distros via wsl.exe. Pure Node built-ins (no node-pty/@parcel/watcher),
// so a single platform-independent bundle suffices; it ships inside the
// Windows app via the same out/relay extraResources mapping.
{
  const wslEntry = join(ROOT, 'src', 'relay', 'wsl-agent-hook-relay.ts')
  const outDir = join(OUT_ROOT, 'wsl')
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
