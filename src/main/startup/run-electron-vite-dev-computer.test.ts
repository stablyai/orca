import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('run-electron-vite-dev Computer Use preparation', () => {
  it.runIf(process.platform === 'darwin')(
    'wires incomplete helper overrides through the production preflight',
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-computer-wiring-'))
      tempDirs.push(tempDir)
      const incompleteOverride = join(tempDir, 'Incomplete Computer Use.app')
      const markerPath = join(tempDir, 'runner.json')
      mkdirSync(incompleteOverride)

      const wrapper = spawn(
        process.execPath,
        [resolve('config/scripts/run-electron-vite-dev.mjs'), '--remote-debugging-port=9451'],
        {
          cwd: resolve('.'),
          env: {
            ...process.env,
            ORCA_COMPUTER_MACOS_HELPER_APP_PATH: incompleteOverride,
            ORCA_ELECTRON_VITE_CLI: resolve(
              'src/main/startup/__fixtures__/fake-electron-vite-once-cli.mjs'
            ),
            ORCA_SKIP_DEV_CLI_PREPARE: '1',
            ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
            ORCA_SKIP_DEV_WEB_PREPARE: '1',
            ORCA_DEV_WRAPPER_TEST_ENV_FILE: markerPath
          },
          stdio: ['ignore', 'ignore', 'pipe']
        }
      )
      let stderr = ''
      wrapper.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })

      const exitCode = await new Promise<number | null>((resolveExit, reject) => {
        wrapper.once('error', reject)
        wrapper.once('exit', resolveExit)
      })

      expect(exitCode).toBe(0)
      expect(readFileSync(markerPath, 'utf8')).toContain('dev')
      expect(stderr).toContain('Computer Use helper override is incomplete')
      expect(stderr).toContain('Fix or unset ORCA_COMPUTER_MACOS_HELPER_APP_PATH')
    }
  )
})
