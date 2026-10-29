#!/usr/bin/env node
// Ship self-contained builtins-only CommonJS WSL hook/network/profile/SQLite programs via out/relay/wsl extraResources.
import { build } from 'esbuild'
import { JSONC_PARSER_ESM_ALIAS } from '../build-plugins/jsonc-parser-esm.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OPENCODE_SQLITE_READER_FILENAME,
  WSL_CLAUDE_PROFILE_HELPER_FILENAME
} from '../../src/shared/remote-bundle-artifacts.ts'

const __dirname = import.meta.dirname
const ROOT = join(__dirname, '..', '..')
// Why: lets a contract test build into a temp tree instead of clobbering a developer's out/relay.
const OUT_ROOT = process.env.ORCA_WSL_GUEST_OUT_ROOT ?? join(ROOT, 'out', 'relay')
const RELAY_VERSION = '0.1.0'

const outDir = join(OUT_ROOT, 'wsl')
// Why: the SSH relay's per-platform directories are gone; a stale one must not ship.
rmSync(OUT_ROOT, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const bundle = (entry, outfile, extra = {}) =>
  build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outDir, outfile),
    sourcemap: false,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    ...extra
  })

function stampVersion(bundleFile, versionFile) {
  const hash = createHash('sha256')
    .update(readFileSync(join(outDir, bundleFile)))
    .digest('hex')
    .slice(0, 12)
  writeFileSync(join(outDir, versionFile), `${RELAY_VERSION}+${hash}`)
}

await bundle('src/wsl-guest/wsl-agent-hook-relay.ts', 'wsl-agent-hook-relay.js', {
  alias: JSONC_PARSER_ESM_ALIAS
})
stampVersion('wsl-agent-hook-relay.js', '.version')
console.log(`Built WSL hook relay → ${outDir}/wsl-agent-hook-relay.js`)

await bundle('src/wsl-guest/wsl-browser-network-relay.ts', 'wsl-browser-network-relay.js')
stampVersion('wsl-browser-network-relay.js', '.browser-network-version')
console.log(`Built WSL browser network relay → ${outDir}/wsl-browser-network-relay.js`)

await bundle(
  'src/main/claude-accounts/claude-profile-wsl-entry.ts',
  WSL_CLAUDE_PROFILE_HELPER_FILENAME
)
await bundle(
  'src/main/ai-vault/session-scanner-opencode-sqlite-process-entry.ts',
  OPENCODE_SQLITE_READER_FILENAME,
  { external: ['electron'] }
)

console.log('WSL guest build complete.')
