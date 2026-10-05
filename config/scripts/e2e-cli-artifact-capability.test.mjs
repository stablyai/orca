import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '../../src/shared/child-process/run-process'

const workflow = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
const build = workflow.jobs.build.steps.find((step) => step.id === 'e2e-cli')
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts

describe('shared E2E CLI capability', () => {
  it('uses the same preparation for locally compiled and downloaded CLI output', () => {
    expect(scripts['build:cli']).toContain('&& pnpm run prepare:cli-output')
    expect(scripts['prepare:cli-output']).toBe(
      'node config/scripts/verify-cli-bin.mjs --fix-executable --fix-package-json && node config/scripts/install-dev-cli.mjs'
    )
  })

  it.skipIf(process.platform === 'win32').each([
    [false, 0, 0],
    [true, 0, 0],
    [true, 7, 7]
  ])('supported=%s build status=%s exits=%s', (supported, buildStatus, exitStatus) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-e2e-cli-capability-'))
    const marker = join(directory, 'build-requested')
    try {
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ scripts: supported ? { 'prepare:cli-output': 'available' } : {} })
      )
      const pnpm = join(directory, 'pnpm')
      writeFileSync(pnpm, '#!/bin/sh\nprintf "%s" "$*" > "$BUILD_MARKER"\nexit "$BUILD_STATUS"\n')
      chmodSync(pnpm, 0o755)
      const result = runProcessSync({
        program: 'bash',
        args: ['-e', '-o', 'pipefail', '-c', build.run],
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH}`,
          BUILD_MARKER: marker,
          BUILD_STATUS: String(buildStatus)
        },
        timeoutMs: 10_000
      })
      expect(result.code, JSON.stringify(result)).toBe(exitStatus)
      expect(existsSync(marker)).toBe(supported)
      if (supported) {
        expect(readFileSync(marker, 'utf8')).toBe('run build:cli')
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
