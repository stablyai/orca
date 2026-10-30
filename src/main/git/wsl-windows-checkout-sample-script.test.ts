import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { SAMPLE_SCRIPT } from './wsl-windows-checkout-git-probe'
import { LINE_ENDING_SAMPLE_LIMIT, LINE_ENDING_SCAN_LIMIT } from './wsl-windows-checkout-git-config'

const TAB = '\t'
const TEXT_AUTO_LINE = `i/lf    w/lf    attr/text=auto        ${TAB}file.txt`
const ELIGIBLE_LINE = `i/lf    w/crlf  attr/                 ${TAB}file.txt`

// An endless stand-in ls-files stream verifies that the real sample pipeline bounds its input.
describe.skipIf(process.platform === 'win32')('line-ending sample pipeline', () => {
  let binDir: string

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'orca-eol-sample-'))
  })

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true })
  })

  function installEndlessGit(line: string): void {
    const fakeGit = join(binDir, 'git')
    writeFileSync(
      fakeGit,
      [
        '#!/bin/sh',
        'case "$3" in',
        '  rev-parse) exit 0 ;;',
        `  ls-files) exec yes '${line}' ;;`,
        'esac',
        'exit 1'
      ].join('\n')
    )
    chmodSync(fakeGit, 0o755)
  }

  function runSample() {
    return runProcess({
      program: '/bin/sh',
      args: [
        '-c',
        SAMPLE_SCRIPT,
        'sh',
        '/repo',
        String(LINE_ENDING_SAMPLE_LIMIT),
        String(LINE_ENDING_SCAN_LIMIT)
      ],
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024
    })
  }

  it('stops reading the index when no entry is eligible (`* text=auto`)', async () => {
    installEndlessGit(TEXT_AUTO_LINE)
    const result = await runSample()
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('still returns a full sample when entries are eligible', async () => {
    installEndlessGit(ELIGIBLE_LINE)
    const result = await runSample()
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stdout.split('\n').filter(Boolean)).toHaveLength(LINE_ENDING_SAMPLE_LIMIT)
  })
})
