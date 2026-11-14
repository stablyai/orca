import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '@orca/process-host'
import { writeOrcadTemplateTestFixture } from '../../orcad-distribution/template/orcad-template-test-fixture.mjs'

const workflow = parse(readFileSync('.github/workflows/qualified-orcad-template.yml', 'utf8'))

it('removes corrupted cached bytes without marking them reusable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qualified-template-restore-'))
  const output = join(root, 'output')
  try {
    symlinkSync(
      resolve('config'),
      join(root, 'config'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const template = await writeOrcadTemplateTestFixture(join(root, 'out'))
    writeFileSync(join(template, 'out/mobile-web/index.html'), 'mutated')
    const validate = workflow.jobs.cache.steps.find((step) => step.id === 'validate')
    const result = runProcessSync({
      program: 'bash',
      args: ['-e', '-c', validate.run],
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output }
    })
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(output)).toBe(false)
    expect(existsSync(template)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
