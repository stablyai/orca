import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

const action = parse(readFileSync('.github/actions/setup-pnpm/action.yml', 'utf8'))
const fallback = action.runs.steps.find(
  (step) => step.name === 'Bootstrap and verify pnpm through npm'
)

function execute({ auditStatus = 0, checksum = 'ab'.repeat(64) } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pnpm-action-'))
  const bin = join(directory, 'bin')
  const marker = join(directory, 'executed')
  const output = join(directory, 'path')
  mkdirSync(bin)
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ packageManager: `pnpm@12.14.0+sha512.${checksum}` })
  )
  const npm = join(bin, 'npm')
  writeFileSync(
    npm,
    `#!/usr/bin/env node
const { chmodSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
if (args[0] === 'audit') process.exit(Number(process.env.TEST_AUDIT_STATUS))
if (args[0] === 'rebuild') {
  writeFileSync(process.env.PNPM_TEST_EXEC_MARKER, 'rebuilt')
  process.exit(0)
}
if (!args.includes('--ignore-scripts') || !args.includes('--save-exact') || !args.includes('pnpm@12.14.0')) process.exit(9)
const root = args[args.indexOf('--prefix') + 1]
const bin = join(root, 'node_modules', '.bin')
mkdirSync(bin, { recursive: true })
const pnpm = join(bin, 'pnpm')
writeFileSync(pnpm, '#!/bin/sh\\nprintf executed > "$PNPM_TEST_EXEC_MARKER"\\nprintf "12.14.0\\\\n"\\n')
chmodSync(pnpm, 0o755)
writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/pnpm': {
  version: '12.14.0',
  resolved: 'https://registry.npmjs.org/pnpm/-/pnpm-12.14.0.tgz',
  integrity: 'sha512-' + Buffer.from('ab'.repeat(64), 'hex').toString('base64')
} } }))
`
  )
  chmodSync(npm, 0o755)
  try {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', fallback.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        RUNNER_TEMP: directory,
        GITHUB_WORKSPACE: directory,
        GITHUB_PATH: output,
        PNPM_MANIFEST: 'package.json',
        TEST_AUDIT_STATUS: String(auditStatus),
        PNPM_TEST_EXEC_MARKER: marker
      }
    })
    return { ...result, executed: existsSync(marker), published: existsSync(output) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it('runs the pinned tool only after signature and manifest integrity verification', () => {
  const result = execute()
  expect(result.status, result.stderr).toBe(0)
  expect(result.executed).toBe(true)
  expect(result.published).toBe(true)
})

it('rejects failed signature verification before running or publishing the tool', () => {
  const result = execute({ auditStatus: 1 })
  expect(result.status).toBe(1)
  expect(result.executed).toBe(false)
  expect(result.published).toBe(false)
})

it('rejects a signed package whose checksum disagrees with the manifest pin', () => {
  const result = execute({ checksum: 'cd'.repeat(64) })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Installed pnpm does not match packageManager integrity')
  expect(result.executed).toBe(false)
  expect(result.published).toBe(false)
})
