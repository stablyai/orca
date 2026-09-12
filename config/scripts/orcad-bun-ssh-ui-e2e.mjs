#!/usr/bin/env node

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readOrcadBunSshTestFile } from './orcad-bun-ssh-test-file.mjs'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const testFile = readOrcadBunSshTestFile(
  process.argv.slice(2),
  'tests/e2e/orcad-managed-ssh-lifecycle.spec.ts'
)
const temporary = mkdtempSync(join(tmpdir(), 'orca-orcad-ssh-ui-'))
const templateDir = join(temporary, 'orcad-template')

function run(program, args, options = {}) {
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    timeoutMs: null,
    ...options
  })
  if (result.code !== 0) {
    process.stderr.write(result.stderr || result.stdout)
    process.exitCode = result.code ?? 1
    return false
  }
  return true
}

try {
  if (!run(pnpm, ['run', 'build:orcad-template'], { stdio: 'inherit' })) {
    process.exit()
  }
  cpSync(join(root, 'out', 'orcad-template'), templateDir, { recursive: true })
  run(
    pnpm,
    [
      'exec',
      'playwright',
      'test',
      testFile,
      '--config',
      'tests/playwright.config.ts',
      '--project',
      'electron-headless',
      '--workers=1'
    ],
    {
      env: {
        ...process.env,
        ORCA_E2E_SSH_DOCKER: '1',
        ORCA_ORCAD_TEMPLATE_PATH: templateDir,
        ORCA_REVIEW_ORCAD_SSH_UI_LIFECYCLE: '1'
      },
      stdio: 'inherit'
    }
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
