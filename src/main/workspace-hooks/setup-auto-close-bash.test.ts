import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SETUP_SUCCESS_EXIT_CODE,
  applySetupAutoCloseSetting,
  buildSetupRunnerCommand
} from '../../shared/setup-runner-command'
import { buildPosixRunnerScript } from './setup-runner-script-text'

// Runs a multi-line setup through the real runner text, launch command and success clause in bash.
describe.skipIf(process.platform === 'win32')('setup auto-close in a real bash', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
    dir = null
  })

  function runSetup(lines: string[]): { status: number | null; ranLastLine: boolean } {
    dir = mkdtempSync(join(tmpdir(), 'orca-setup-autoclose-'))
    const runner = join(dir, 'setup-runner.sh')
    const marker = join(dir, 'last-line-ran')
    writeFileSync(runner, buildPosixRunnerScript([...lines, `touch '${marker}'`].join('\n')))
    const command = applySetupAutoCloseSetting(
      buildSetupRunnerCommand(runner, 'posix'),
      'posix',
      undefined,
      { closeSetupTabOnSuccess: true }
    )
    const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' })
    return { status: result.status, ranLastLine: existsSync(marker) }
  }

  it('exits with the success code only after every command succeeded', () => {
    expect(runSetup(['echo first', 'echo second'])).toEqual({
      status: SETUP_SUCCESS_EXIT_CODE,
      ranLastLine: true
    })
  })

  it('stops at the first failing command and never reaches the success exit', () => {
    expect(runSetup(['echo first', 'false', 'echo never'])).toEqual({
      status: 1,
      ranLastLine: false
    })
  })
})
