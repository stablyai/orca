#!/usr/bin/env node
// Raise the store floor: recreate each store as the given release tag does, into the floor fixture.
// Usage: node config/scripts/store-compatibility/write-floor-store-schemas.mjs v1.4.263
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const tag = process.argv[2]
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('Usage: write-floor-store-schemas.mjs v<major>.<minor>.<patch>')
  process.exit(2)
}
const repo = resolve(import.meta.dirname, '../../..')
const moduleDir = 'src/main/store-compatibility'
const output = join(repo, moduleDir, 'fixtures', `${tag.slice(1)}-store-schemas.json`)
const positionalOutput = join(
  repo,
  moduleDir,
  'fixtures',
  `${tag.slice(1)}-positional-insert-tables.json`
)
const checkout = mkdtempSync(join(tmpdir(), 'store-floor-'))
// Only pnpm needs a shell on Windows (pnpm.cmd); its arguments hold no paths, so paths with spaces stay intact.
const run = (command, args, cwd = repo, env = process.env) =>
  execFileSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'pnpm'
  })

// Tables the tag inserts into without a column list; an added column breaks those inserts.
function positionalInsertTables(root) {
  const insert =
    /INSERT(?:\s+OR\s+(?:\w+|\$\{[^}]*\}))?\s+INTO\s+([A-Za-z_][\w.]*)\s+(?:VALUES|SELECT)\b/gi
  const tables = new Set()
  for (const entry of readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })) {
    const file = join(entry.parentPath, entry.name)
    if (
      entry.isFile() &&
      /\.(?:ts|tsx|mjs|js)$/.test(entry.name) &&
      !/\.(?:test|spec)\.|test-fixture|[\\/]testing[\\/]/.test(file)
    ) {
      for (const match of readFileSync(file, 'utf8').matchAll(insert)) {
        if (!match[1].startsWith('temp.')) {
          tables.add(match[1])
        }
      }
    }
  }
  return [...tables].sort()
}

run('git', ['worktree', 'add', '--detach', checkout, tag])
try {
  for (const file of [
    'store-schema-snapshot.test-fixture.ts',
    'floor-checked-stores.test-fixture.ts'
  ]) {
    cpSync(join(repo, moduleDir, file), join(checkout, moduleDir, file))
  }
  // A test runs the tag's own store openers inside its own test runtime.
  writeFileSync(
    join(checkout, moduleDir, 'write-floor-store-schemas.test.ts'),
    [
      "import { mkdtempSync, writeFileSync } from 'node:fs'",
      "import { tmpdir } from 'node:os'",
      "import { join } from 'node:path'",
      "import { it } from 'vitest'",
      "import { formatFloorStoreSchemas } from './floor-checked-stores.test-fixture'",
      "it('writes the floor store schemas', () => {",
      "  const dir = mkdtempSync(join(tmpdir(), 'store-floor-schemas-'))",
      `  writeFileSync(${JSON.stringify(output)}, formatFloorStoreSchemas(dir))`,
      '})',
      ''
    ].join('\n')
  )
  writeFileSync(positionalOutput, `${JSON.stringify(positionalInsertTables(checkout), null, 2)}\n`)
  run('pnpm', ['install', '--frozen-lockfile'], checkout)
  run(
    'pnpm',
    ['test', `${moduleDir}/write-floor-store-schemas.test.ts`, '--maxWorkers=1'],
    checkout
  )
  console.log(
    `Wrote ${output} and ${positionalOutput}. Point STORE_FLOOR at them and update its release, commit and versions.`
  )
} finally {
  run('git', ['worktree', 'remove', '--force', checkout])
  rmSync(checkout, { recursive: true, force: true })
}
