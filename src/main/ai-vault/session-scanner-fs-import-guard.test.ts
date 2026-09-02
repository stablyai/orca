import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const AI_VAULT_DIR = join(import.meta.dirname, '.')
const NATIVE_CHAT_DIR = join(import.meta.dirname, '..', 'native-chat')

// Transcript I/O in these modules must go through the WSL admission gate, so a
// stalled 9P mount cannot hang a scan or a Native Chat load (STA-4049).
const NATIVE_CHAT_MODULES = [
  'transcript-read-cache.ts',
  'transcript-reader.ts',
  'transcript-tail-reader.ts',
  'transcript-file-version.ts',
  'transcript-incremental-reader.ts',
  'transcript-watch-engine.ts'
]

// Adding to this list must be a reviewed act: each entry names why the file
// touches a path that can never be a WSL UNC transcript.
const ALLOWLIST = new Set([
  // `existsSync` on bundled module paths inside the app dir.
  'session-scanner-service-entry-path.ts',
  'session-scanner-service-spawn.ts',
  'session-scanner-worker-spawn.ts',
  'session-scanner-opencode-sqlite-worker-spawn.ts',
  // On-demand IPC readers, gated in the STA-4049 follow-up.
  'session-scanner-claude-subagents.ts',
  'session-scanner-omp-subagent-listing.ts',
  // Test-only fixture builder.
  'session-scanner-test-fixtures.ts'
])

const FS_IMPORT = /import\s+([\s\S]*?)\s+from\s+['"]node:fs(?:\/promises)?['"]/g

function valueImportsOfNodeFs(source: string): string[] {
  return [...source.matchAll(FS_IMPORT)]
    .map((match) => match[1]!.trim())
    .filter((clause) => !clause.startsWith('type'))
}

async function guardedFiles(): Promise<{ name: string; path: string }[]> {
  const aiVault = (await readdir(AI_VAULT_DIR))
    .filter((name) => name.startsWith('session-scanner') || name === 'session-title-file-reader.ts')
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => !ALLOWLIST.has(name))
    .map((name) => ({ name, path: join(AI_VAULT_DIR, name) }))
  return [
    ...aiVault,
    ...NATIVE_CHAT_MODULES.map((name) => ({ name, path: join(NATIVE_CHAT_DIR, name) }))
  ]
}

describe('WSL transcript gate import guard', () => {
  it('leaves no raw node:fs value import in a gated transcript module', async () => {
    const files = await guardedFiles()
    const offenders: string[] = []
    for (const file of files) {
      for (const clause of valueImportsOfNodeFs(await readFile(file.path, 'utf-8'))) {
        offenders.push(`${file.name}: import ${clause} from 'node:fs…'`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('actually covers the modules it claims to', async () => {
    const names = (await guardedFiles()).map((file) => file.name)
    expect(names).toEqual(expect.arrayContaining(NATIVE_CHAT_MODULES))
    // The V12–V17 sites the previous `*parser*` wording silently skipped.
    expect(names).toEqual(
      expect.arrayContaining([
        'session-title-file-reader.ts',
        'session-scanner.ts',
        'session-scanner-values.ts',
        'session-scanner-codex-title-index.ts',
        'session-scanner-kimi-paths.ts',
        'session-scanner-opencode-sources.ts'
      ])
    )
  })
})
