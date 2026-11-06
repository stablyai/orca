import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '@orca/process-host'
import { writeOrcadTemplateTestFixture } from '../../orcad-distribution/template/orcad-template-test-fixture.mjs'

const workflow = parse(readFileSync('.github/workflows/qualified-orcad-template.yml', 'utf8'))

it.each(['valid', 'corrupt', 'dark'])(
  'validates restored bytes and requalifies an unsafe template: %s',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'qualified-template-restore-'))
    const output = join(root, 'output')
    try {
      symlinkSync(
        resolve('config'),
        join(root, 'config'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      const template = await writeOrcadTemplateTestFixture(join(root, 'out'))
      if (kind === 'corrupt') {
        writeFileSync(join(template, 'out/mobile-web/index.html'), 'mutated')
      } else if (kind === 'dark') {
        writeFileSync(join(template, 'ORCA_LAYOUT_OWNER_MAIN'), 'dark build')
      }
      const validate = workflow.jobs.cache.steps.find((step) => step.id === 'validate')
      const result = runProcessSync({
        program: 'bash',
        args: ['-e', '-c', validate.run],
        cwd: root,
        env: { ...process.env, GITHUB_OUTPUT: output }
      })
      expect(result.code, result.stderr).toBe(0)
      if (kind === 'valid') {
        expect(readFileSync(output, 'utf8').trim()).toBe('valid=true')
        expect(existsSync(template)).toBe(true)
      } else {
        expect(existsSync(output)).toBe(false)
        expect(existsSync(template)).toBe(false)
        expect(result.stdout).toContain('qualifying a fresh build')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
