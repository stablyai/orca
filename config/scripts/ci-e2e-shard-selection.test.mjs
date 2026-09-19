import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import { planE2e, verifyE2eSelection } from './ci-e2e-shard-plan.mjs'

const require = createRequire(import.meta.url)

it('native Playwright test-list preserves full discovery, serial suites, skips and headful filtering', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-playwright-shards-')))
  const testPackage = JSON.stringify(require.resolve('@stablyai/playwright-test'))
  const config = join(directory, 'playwright.config.cjs')
  writeFileSync(
    config,
    `module.exports = { testDir: '.', fullyParallel: true, projects: [{ name: 'electron-headless', grepInvert: /@headful/ }] }`
  )
  for (let index = 0; index < 17; index++) {
    writeFileSync(
      join(directory, `file-${index}.spec.cjs`),
      `
      const { test } = require(${testPackage});
      test('normal', () => {});
      test.skip('skipped', () => {});
      test('visible @headful', () => {});
      test.describe.serial('serial', () => {
        test('first', () => {});
        test('second', () => {});
      });
    `
    )
  }
  async function discover(extra = []) {
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
        ...extra
      ],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20000
    })
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  try {
    const full = await discover()
    const assignment = planE2e(full, 14, { timings: {} })
    const ids = []
    for (let index = 0; index < 14; index++) {
      const path = join(directory, 'selected.txt')
      writeFileSync(path, `${assignment.shards[index].files.join('\n')}\n`)
      const selected = await discover(['--test-list', path])
      verifyE2eSelection({ ...assignment, selectedShard: index + 1 }, selected)
      for (const suite of selected.suites) {
        expect(suite.specs.some((spec) => spec.title.includes('@headful'))).toBe(false)
      }
      ids.push(...assignment.shards[index].files.flatMap((file) => assignment.testsByFile[file]))
    }
    expect(ids).toHaveLength(17 * 4)
    expect(new Set(ids).size).toBe(ids.length)
    expect(() => verifyE2eSelection({ ...assignment, selectedShard: 1 }, full)).toThrow('differs')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60000)
