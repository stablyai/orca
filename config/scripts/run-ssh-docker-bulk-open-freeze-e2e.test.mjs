import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(
  new URL('./run-ssh-docker-bulk-open-freeze-e2e.mjs', import.meta.url)
)

describe('SSH Docker bulk-open freeze runner', () => {
  it('invokes pnpm from PATH when npm_execpath is a native executable', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'orca-bulk-open-pnpm-'))
    const logPath = path.join(tempDir, 'pnpm.log')
    const shimPath = path.join(tempDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'

    try {
      writePnpmShim(shimPath)
      const result = spawnSync(process.execPath, [scriptPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          [pathKey]: `${tempDir}${path.delimiter}${process.env[pathKey] ?? ''}`,
          npm_execpath: process.execPath,
          ORCA_TEST_PNPM_LOG: logPath
        }
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(logPath, 'utf8').replaceAll('\r\n', '\n')).toBe(
        [
          'run ensure:electron-runtime',
          'exec playwright test tests/e2e/ssh-docker-bulk-open-freeze-repro.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1',
          ''
        ].join('\n')
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

function writePnpmShim(shimPath) {
  if (process.platform === 'win32') {
    writeFileSync(shimPath, '@echo off\r\necho %*>>"%ORCA_TEST_PNPM_LOG%"\r\n', 'utf8')
    return
  }
  writeFileSync(shimPath, '#!/bin/sh\nprintf \'%s\\n\' "$*" >>"$ORCA_TEST_PNPM_LOG"\n', 'utf8')
  chmodSync(shimPath, 0o755)
}
