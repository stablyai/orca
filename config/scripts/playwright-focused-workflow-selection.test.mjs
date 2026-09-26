import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'

const require = createRequire(import.meta.url)
const projectDir = resolve(import.meta.dirname, '../..')

function focusedArguments() {
  const commands = []
  for (const filename of ['terminal-ime-e2e.yml', 'golden-e2e-experiment.yml']) {
    const workflow = parse(readFileSync(join(projectDir, '.github/workflows', filename), 'utf8'))
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        for (const match of (step.run ?? '').matchAll(/\bpnpm run test:e2e\s+([^\n]+)/g)) {
          commands.push(match[1].trim().split(/\s+/))
        }
      }
    }
  }
  const runner = readFileSync(
    join(projectDir, 'config/scripts/run-terminal-ibus-hangul-e2e.mjs'),
    'utf8'
  )
  const native = runner.match(/\[\s*'run',\s*'test:e2e:headful',([\s\S]*?)\]/)
  expect(native).not.toBeNull()
  expect(native[1].replace(/'[^']*'|[\s,]/g, '')).toBe('')
  commands.push([...native[1].matchAll(/'([^']*)'/g)].map((match) => match[1]))
  return [...new Map(commands.map((args) => [JSON.stringify(args), args])).values()]
}

it('focused IME and golden commands discover only their requested files with the installed Playwright CLI', async () => {
  const commands = focusedArguments()
  expect(commands).toHaveLength(4)
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-playwright-focused-')))
  const config = join(directory, 'playwright.config.cjs')
  const testPackage = JSON.stringify(require.resolve('@stablyai/playwright-test'))
  try {
    mkdirSync(join(directory, 'tests/e2e'), { recursive: true })
    writeFileSync(config, "module.exports = { testDir: '.', testMatch: '**/*.spec.ts' }")
    const requestedFiles = commands.flatMap((args) =>
      args.filter((arg) => arg.endsWith('.spec.ts'))
    )
    for (const filename of new Set([...requestedFiles, 'tests/e2e/unrelated.spec.ts'])) {
      writeFileSync(
        join(directory, filename),
        `const { test } = require(${testPackage}); test('selected', () => {});`
      )
    }
    for (const args of commands) {
      const result = await runProcess({
        program: process.execPath,
        cwd: directory,
        args: [
          join(dirname(require.resolve('playwright/package.json')), 'cli.js'),
          'test',
          '--config',
          config,
          '--list',
          '--reporter=json',
          ...args
        ],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 20_000
      })
      expect(result.code, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout)
      const expected = args.filter((arg) => arg.endsWith('.spec.ts')).sort()
      expect(
        report.suites.map((suite) => suite.file.replaceAll('\\', '/')).sort(),
        JSON.stringify(args)
      ).toEqual(expected)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
