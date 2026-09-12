#!/usr/bin/env node
/**
 * Bundle the relay daemon and its crash-isolated watcher child per platform.
 *
 * The relay runs on remote hosts via `relay.js`; the CommonJS bundle stays
 * compatible with host Node while an optional target-native Bun executable
 * can be staged beside it. Native addons (node-pty, @parcel/watcher) are
 * marked external and expected to be installed on the remote or gracefully
 * degraded.
 */
import { build } from 'esbuild'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import {
  RELAY_BUILD_PLATFORMS,
  RELAY_BUN_RUNTIME_FILENAME,
  RELAY_WINDOWS_BUN_RUNTIME_FILENAME,
  relayBunRuntimeFilename,
  RELAY_BUN_GLIBC_RUNTIME_FILENAME,
  RELAY_BUN_MUSL_RUNTIME_FILENAME,
  RELAY_BUN_REQUIRED_FILENAME,
  RELAY_VERSION_FILENAME,
  RELAY_WINDOWS_PROCESS_TREE_FILENAME,
  relayOptionalArtifactFilenames,
  isWindowsRelayPlatform,
  relayArtifactFilenames
} from '../../src/shared/relay-artifacts.ts'
import { WSL_HOOK_RELAY_BUN_REQUIRED_FILE } from '../../src/shared/wsl-hook-relay-contract.ts'
import { WSL_BROWSER_NETWORK_RELAY_BUN_REQUIRED_FILE } from '../../src/shared/wsl-browser-network-relay-contract.ts'

const __dirname = import.meta.dirname
// Why: the script lives under config/scripts, so go two levels up to reach the repo root.
const ROOT = join(__dirname, '..', '..')
const RELAY_ENTRY = join(ROOT, 'src', 'relay', 'relay.ts')
const WATCHER_ENTRY = join(ROOT, 'src', 'main', 'ipc', 'parcel-watcher-process-entry.ts')
const PTY_GATE_ENTRY = join(ROOT, 'src/main/daemon/pty-subprocess/windows-bun-pty-gate-entry.ts')
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
const PARCEL_WATCHER_ROOT = join(ROOT, 'node_modules', '@parcel', 'watcher')
const JSONC_PARSER_ESM_ENTRY = join(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js')
const NODE_PTY_CONSOLE_LIST_PATCH_FILENAME = 'node-pty-1.1.0-console-list-agent-patch.cjs'
const NODE_PTY_CONSOLE_LIST_PATCH_SOURCE = join(
  ROOT,
  'config',
  'relay-assets',
  NODE_PTY_CONSOLE_LIST_PATCH_FILENAME
)
const NODE_PTY_WINDOWS_TEARDOWN_PATCH_FILENAME = 'node-pty-1.1.0-windows-pty-teardown-patch.cjs'
const NODE_PTY_WINDOWS_TEARDOWN_PATCH_SOURCE = join(
  ROOT,
  'config',
  'relay-assets',
  NODE_PTY_WINDOWS_TEARDOWN_PATCH_FILENAME
)
const NODE_PTY_MASTER_CLOEXEC_PATCH_FILENAME = 'node-pty-1.1.0-master-cloexec-patch.cjs'
const NODE_PTY_MASTER_CLOEXEC_PATCH_SOURCE = join(
  ROOT,
  'config',
  'relay-assets',
  NODE_PTY_MASTER_CLOEXEC_PATCH_FILENAME
)
// Written by build-windows-process-tree-relay-addon.mjs, which only runs on a
// Windows machine.
const WINDOWS_PROCESS_TREE_BUILD_DIR = join(ROOT, '.build', 'windows-process-tree')

// Which Windows arches must have the addon, as a comma-separated list ('all' for
// every arch). Per-arch rather than a flag because arm64 needs the MSVC ARM64
// cross toolset, an optional VS component: where it is absent that relay should
// fall back to the scan, not fail the release the x64 relay is riding on.
const REQUIRED_ADDON_ARCHES = (process.env.ORCA_REQUIRE_RELAY_NATIVE_ADDONS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

// Relay bundles are still Node-compatible by default. Release jobs that have
// already materialized the pinned Bun matrix can opt into shipping the matching
// executable beside relay.js without making ordinary relay builds download it.
const RELAY_BUN_RUNTIME_ROOT = process.env.ORCA_RELAY_BUN_RUNTIME_ROOT
const REQUIRE_RELAY_BUN_RUNTIME = process.env.ORCA_REQUIRE_RELAY_BUN_RUNTIME === '1'
const requireFromRoot = createRequire(join(ROOT, 'package.json'))

function stageRelayBunRuntime(platform, outDir) {
  rmSync(join(outDir, RELAY_BUN_REQUIRED_FILENAME), { force: true })
  if (!RELAY_BUN_RUNTIME_ROOT) {
    if (REQUIRE_RELAY_BUN_RUNTIME) {
      throw new Error(
        'ORCA_REQUIRE_RELAY_BUN_RUNTIME=1 requires ORCA_RELAY_BUN_RUNTIME_ROOT with a runtime for every relay target.'
      )
    }
    return false
  }
  const runtimes = isLinuxRelayPlatform(platform)
    ? [
        { target: `${platform}-glibc`, filename: RELAY_BUN_GLIBC_RUNTIME_FILENAME },
        { target: `${platform}-musl`, filename: RELAY_BUN_MUSL_RUNTIME_FILENAME }
      ]
    : [{ target: platform, filename: relayBunRuntimeFilename(platform) }]
  // Build output directories are reused by local and release builds. Remove
  // an older companion before deciding whether this build may ship one.
  for (const { filename } of runtimes) {
    rmSync(join(outDir, filename), { force: true })
  }
  if (isWindowsRelayPlatform(platform)) {
    rmSync(join(outDir, RELAY_BUN_RUNTIME_FILENAME), { force: true })
  }
  const missing = runtimes.filter(
    ({ target }) =>
      !existsSync(join(RELAY_BUN_RUNTIME_ROOT, target, orcadBunRuntimeFilename(target)))
  )
  if (missing.length > 0 && REQUIRE_RELAY_BUN_RUNTIME) {
    const paths = missing
      .map(({ target }) => join(RELAY_BUN_RUNTIME_ROOT, target, orcadBunRuntimeFilename(target)))
      .join(', ')
    throw new Error(
      `Relay ${platform} needs bundled Bun runtimes: ${paths}. Materialize the target-native Bun matrix or unset ORCA_REQUIRE_RELAY_BUN_RUNTIME.`
    )
  }
  for (const { target, filename } of runtimes) {
    const source = join(RELAY_BUN_RUNTIME_ROOT, target, orcadBunRuntimeFilename(target))
    if (!existsSync(source)) {
      console.log(`Relay ${platform}: no ${filename}; Node fallback remains active.`)
      continue
    }
    const destination = join(outDir, filename)
    if (resolve(source) !== resolve(destination)) {
      copyFileSync(source, destination)
    }
    if (!isWindowsRelayPlatform(platform)) {
      // SFTP does not preserve execute bits; the deploy path also repairs this
      // bit after upload for hosts that mount the package with a restrictive umask.
      chmodSync(destination, 0o755)
    }
  }
  if (REQUIRE_RELAY_BUN_RUNTIME) {
    // The marker is part of the immutable relay version and tells runtime
    // selection that host Node fallback is forbidden for this package.
    writeFileSync(join(outDir, RELAY_BUN_REQUIRED_FILENAME), 'bun\n')
  }
  return missing.length < runtimes.length
}

/** WSL guests are Linux targets even though the desktop bundle is Windows. */
function stageWslBunRuntimes(outDir) {
  const runtimeFilenames = [
    'bun-runtime-linux-x64-glibc',
    'bun-runtime-linux-x64-musl',
    'bun-runtime-linux-arm64-glibc',
    'bun-runtime-linux-arm64-musl'
  ]
  for (const filename of runtimeFilenames) {
    rmSync(join(outDir, filename), { force: true })
  }
  rmSync(join(outDir, WSL_HOOK_RELAY_BUN_REQUIRED_FILE), { force: true })
  rmSync(join(outDir, WSL_BROWSER_NETWORK_RELAY_BUN_REQUIRED_FILE), { force: true })
  if (!RELAY_BUN_RUNTIME_ROOT) {
    if (REQUIRE_RELAY_BUN_RUNTIME) {
      throw new Error('Strict relay release requires Linux Bun runtimes for WSL guests.')
    }
    return []
  }
  const staged = []
  for (const arch of ['x64', 'arm64']) {
    for (const libc of ['glibc', 'musl']) {
      const target = `linux-${arch}-${libc}`
      const source = join(RELAY_BUN_RUNTIME_ROOT, target, orcadBunRuntimeFilename(target))
      if (!existsSync(source)) {
        if (REQUIRE_RELAY_BUN_RUNTIME) {
          throw new Error(`WSL relay needs bundled Bun runtime: ${source}`)
        }
        continue
      }
      const destination = join(outDir, `bun-runtime-linux-${arch}-${libc}`)
      copyFileSync(source, destination)
      chmodSync(destination, 0o700)
      staged.push(`bun-runtime-linux-${arch}-${libc}`)
    }
  }
  if (REQUIRE_RELAY_BUN_RUNTIME) {
    // The marker is copied into the guest launcher rather than used as a
    // runtime artifact. Hashing it into the version makes a legacy guest
    // launcher stale when a release changes from Node fallback to Bun-only.
    writeFileSync(join(outDir, WSL_HOOK_RELAY_BUN_REQUIRED_FILE), 'bun\n')
    writeFileSync(join(outDir, WSL_BROWSER_NETWORK_RELAY_BUN_REQUIRED_FILE), 'bun\n')
  }
  return staged
}

function isLinuxRelayPlatform(platform) {
  return platform.startsWith('linux-')
}

function stageWindowsProcessTreeAddon(platform, outDir) {
  if (!isWindowsRelayPlatform(platform)) {
    return
  }
  const arch = platform.slice('win32-'.length)
  const source = join(WINDOWS_PROCESS_TREE_BUILD_DIR, arch, RELAY_WINDOWS_PROCESS_TREE_FILENAME)
  if (!existsSync(source)) {
    if (REQUIRED_ADDON_ARCHES.includes(arch) || REQUIRED_ADDON_ARCHES.includes('all')) {
      throw new Error(
        `Relay ${platform} needs ${source}. Run: node config/scripts/build-windows-process-tree-relay-addon.mjs --arch=${arch} (Windows only).`
      )
    }
    console.log(
      `Relay ${platform}: no ${RELAY_WINDOWS_PROCESS_TREE_FILENAME}; relay will use the PowerShell scan.`
    )
    return
  }
  copyFileSync(source, join(outDir, RELAY_WINDOWS_PROCESS_TREE_FILENAME))
}

/**
 * Ship the watcher JavaScript wrapper and target-native N-API binaries with
 * every relay. Bun can load these files directly, so a strict Bun relay never
 * needs a host Node/npm install. Linux carries both libc variants and the
 * wrapper selects the one matching the guest at runtime.
 */
async function stageRelayWatcherNative(platform, outDir) {
  const moduleDir = join(outDir, 'node_modules', '@parcel', 'watcher')
  const wrapperOut = join(moduleDir, 'wrapper.js')
  mkdirSync(moduleDir, { recursive: true })
  await build({
    stdin: {
      contents: readFileSync(join(PARCEL_WATCHER_ROOT, 'wrapper.js'), 'utf8'),
      resolveDir: PARCEL_WATCHER_ROOT,
      sourcefile: 'relay-parcel-watcher-wrapper.js'
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: wrapperOut,
    sourcemap: false,
    minify: true,
    logLevel: 'error'
  })

  const targets = platform.startsWith('linux-')
    ? [`${platform}-glibc`, `${platform}-musl`]
    : [platform]
  for (const target of targets) {
    const nativeSource = requireFromRoot.resolve(`@parcel/watcher-${target}/watcher.node`)
    const flavor = target.endsWith('-musl')
      ? 'musl'
      : target.endsWith('-glibc')
        ? 'glibc'
        : 'native'
    const nativeDestination = join(moduleDir, `native-${flavor}`, 'watcher.node')
    mkdirSync(join(moduleDir, `native-${flavor}`), { recursive: true })
    copyFileSync(nativeSource, nativeDestination)
  }

  const nativeLoad = platform.startsWith('linux-')
    ? [
        // Prefer the execution runtime's libc report (or an explicit launcher
        // hint) so a musl guest never intentionally probes the glibc addon.
        "const h=process.report?.getReport?.()?.header; const libc=process.env.ORCA_RELAY_LIBC || (h?.glibcVersionRuntime?'glibc':undefined);",
        "if(libc==='musl'){try{binding=require('./native-musl/watcher.node')}catch{}}else if(libc==='glibc'){try{binding=require('./native-glibc/watcher.node')}catch{}}else{try{binding=require('./native-glibc/watcher.node')}catch{try{binding=require('./native-musl/watcher.node')}catch{}}}"
      ].join('')
    : `binding=require('./native-native/watcher.node')`
  const index = [
    "'use strict';",
    "const {createWrapper}=require('./wrapper.js'); let binding;",
    nativeLoad,
    "if(!binding) throw new Error('No target-native @parcel/watcher binary bundled');",
    'module.exports=createWrapper(binding);',
    ''
  ].join('\n')
  writeFileSync(join(moduleDir, 'index.js'), index)
  writeFileSync(
    join(moduleDir, 'package.json'),
    `${JSON.stringify({ name: '@parcel/watcher', version: '2.5.6', main: 'index.js', type: 'commonjs' })}\n`
  )
}

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

  await stageRelayWatcherNative(platform, outDir)

  await build({
    entryPoints: [PTY_GATE_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outDir, 'windows-bun-pty-gate-entry.js'),
    sourcemap: false,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' }
  })

  if (isWindowsRelayPlatform(platform)) {
    copyFileSync(
      NODE_PTY_CONSOLE_LIST_PATCH_SOURCE,
      join(outDir, NODE_PTY_CONSOLE_LIST_PATCH_FILENAME)
    )
    copyFileSync(
      NODE_PTY_WINDOWS_TEARDOWN_PATCH_SOURCE,
      join(outDir, NODE_PTY_WINDOWS_TEARDOWN_PATCH_FILENAME)
    )
  }
  copyFileSync(
    NODE_PTY_MASTER_CLOEXEC_PATCH_SOURCE,
    join(outDir, NODE_PTY_MASTER_CLOEXEC_PATCH_FILENAME)
  )
  stageWindowsProcessTreeAddon(platform, outDir)
  stageRelayBunRuntime(platform, outDir)

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
  const expected = relayArtifactFilenames(platform)
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
  // Why hashed only when present: a relay carrying the native addon answers
  // differently from one that falls back to the scan, so the two must not share
  // an immutable directory -- but a build without it is still valid.
  for (const filename of relayOptionalArtifactFilenames(platform)) {
    const artifactPath = join(outDir, filename)
    if (existsSync(artifactPath)) {
      if (filename === RELAY_WINDOWS_BUN_RUNTIME_FILENAME) {
        hash.update(`${filename}\0`)
      }
      hash.update(readFileSync(artifactPath))
    }
  }
  const contentHash = hash.digest('hex').slice(0, 12)

  // Close the loop: an artifact emitted here but absent from the manifest would
  // ship unhashed and unprobed — exactly how the WSL helper went missing.
  const emitted = listFilesRelative(outDir).filter((name) => name !== RELAY_VERSION_FILENAME)
  const declared = [...expected, ...relayOptionalArtifactFilenames(platform)]
  const undeclared = emitted.filter((name) => !declared.includes(name))
  if (undeclared.length > 0) {
    throw new Error(
      `Relay ${platform} emitted undeclared artifacts: ${undeclared.join(', ')}. ` +
        'Add them to RELAY_ARTIFACTS in src/shared/relay-artifacts.ts.'
    )
  }
  writeFileSync(join(outDir, RELAY_VERSION_FILENAME), `${RELAY_VERSION}+${contentHash}`)

  console.log(`Built relay for ${platform} → ${outDir}/relay.js`)
}

function listFilesRelative(rootDir, currentDir = rootDir) {
  const entries = []
  for (const name of readdirSync(currentDir, { withFileTypes: true })) {
    const path = join(currentDir, name.name)
    if (name.isDirectory()) {
      entries.push(...listFilesRelative(rootDir, path))
    } else if (name.isFile()) {
      entries.push(path.slice(rootDir.length + 1))
    }
  }
  return entries
}

// WSL agent-hook relay: a hooks-only guest receiver launched inside WSL
// distros via wsl.exe. Pure Node built-ins (no node-pty/@parcel/watcher),
// so a single platform-independent bundle suffices; it ships inside the
// Windows app via the same out/relay extraResources mapping.
{
  const wslHookEntry = join(ROOT, 'src', 'relay', 'wsl-agent-hook-relay.ts')
  const wslBrowserNetworkEntry = join(ROOT, 'src', 'relay', 'wsl-browser-network-relay.ts')
  const outDir = join(OUT_ROOT, 'wsl')
  mkdirSync(outDir, { recursive: true })
  const stagedWslRuntimes = stageWslBunRuntimes(outDir)
  await build({
    entryPoints: [wslHookEntry],
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
  const hashInput = createHash('sha256').update(content)
  if (existsSync(join(outDir, WSL_HOOK_RELAY_BUN_REQUIRED_FILE))) {
    hashInput.update(readFileSync(join(outDir, WSL_HOOK_RELAY_BUN_REQUIRED_FILE)))
  }
  for (const filename of stagedWslRuntimes) {
    hashInput.update(readFileSync(join(outDir, filename)))
  }
  const hash = hashInput.digest('hex').slice(0, 12)
  writeFileSync(join(outDir, '.version'), `${RELAY_VERSION}+${hash}`)
  console.log(`Built WSL hook relay → ${outDir}/wsl-agent-hook-relay.js`)

  await build({
    entryPoints: [wslBrowserNetworkEntry],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outDir, 'wsl-browser-network-relay.js'),
    sourcemap: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  })
  const browserNetworkContent = readFileSync(join(outDir, 'wsl-browser-network-relay.js'))
  const browserNetworkHashInput = createHash('sha256').update(browserNetworkContent)
  if (existsSync(join(outDir, WSL_BROWSER_NETWORK_RELAY_BUN_REQUIRED_FILE))) {
    browserNetworkHashInput.update(
      readFileSync(join(outDir, WSL_BROWSER_NETWORK_RELAY_BUN_REQUIRED_FILE))
    )
  }
  for (const filename of stagedWslRuntimes) {
    browserNetworkHashInput.update(readFileSync(join(outDir, filename)))
  }
  const browserNetworkHash = browserNetworkHashInput.digest('hex').slice(0, 12)
  writeFileSync(join(outDir, '.browser-network-version'), `${RELAY_VERSION}+${browserNetworkHash}`)
  console.log(`Built WSL browser network relay → ${outDir}/wsl-browser-network-relay.js`)
}

console.log('Relay build complete.')
