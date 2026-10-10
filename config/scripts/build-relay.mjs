#!/usr/bin/env node
/**
 * Bundle the programs Orca runs inside WSL distros: the WSL agent-hook relay, the WSL browser
 * network relay, the Claude profile helper, and the OpenCode SQLite reader. Each is a
 * self-contained CommonJS bundle with only Node.js built-ins; the Windows app ships them from
 * out/relay/wsl via the relay extraResources mapping.
 */
import { build } from 'esbuild'
import { JSONC_PARSER_ESM_ALIAS } from '../build-plugins/jsonc-parser-esm.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RELAY_OPENCODE_SQLITE_READER_FILENAME,
  WSL_CLAUDE_PROFILE_HELPER_FILENAME
} from '../../src/shared/relay-artifacts.ts'

const __dirname = import.meta.dirname
// Why: the script lives under config/scripts, so go two levels up to reach the repo root.
const ROOT = join(__dirname, '..', '..')
// Why: lets a contract test build into a temp tree instead of clobbering a developer's out/relay.
const OUT_ROOT = process.env.ORCA_RELAY_OUT_ROOT ?? join(ROOT, 'out', 'relay')
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
  RELAY_OPENCODE_SQLITE_READER_FILENAME,
  { external: ['electron'] }
)

console.log('WSL guest build complete.')
