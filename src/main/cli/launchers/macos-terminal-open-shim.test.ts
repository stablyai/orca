import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMacosTerminalOpenShimEnv,
  buildMacosTerminalOpenShimScript,
  ensureMacosTerminalOpenShimDir
} from './macos-terminal-open-shim'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('macos-terminal-open-shim', () => {
  it.skipIf(process.platform === 'win32')(
    'routes single http(s) URLs with ORCA_PANE_KEY silently and handles scrubbed pane env',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-open-shim-'))
      tempDirs.push(dir)
      const argsLog = join(dir, 'cli-args.txt')
      const cliBinDir = join(dir, 'cli', 'bin')
      mkdirSync(cliBinDir, { recursive: true })
      const fakeCli = join(cliBinDir, 'orca-dev')
      writeFileSync(fakeCli, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsLog}"\nexit 0\n`, {
        mode: 0o755
      })
      chmodSync(fakeCli, 0o755)

      const shimDir = await ensureMacosTerminalOpenShimDir({
        userDataPath: dir,
        cliLauncher: fakeCli,
        platform: 'darwin'
      })
      expect(shimDir).toBe(join(dir, 'macos-open-shim'))

      const url =
        'https://auth.example.com/oauth2/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8400'
      const result = spawnSync(join(shimDir!, 'open'), [url], {
        env: { ...process.env, ORCA_PANE_KEY: 'tab-1:leaf-1', ORCA_CLI_COMMAND: fakeCli },
        encoding: 'utf8'
      })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(readFileSync(argsLog, 'utf8').trim().split('\n')).toEqual([
        'open-url',
        '--environment',
        'local',
        '--url',
        url,
        '--if-mobile-viewing',
        '--quiet'
      ])

      const scrubbedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ORCA_AGENT_PANE: 'tab-1:leaf-1',
        ORCA_CLI_COMMAND: fakeCli
      }
      delete scrubbedEnv.ORCA_PANE_KEY
      const scrubbed = spawnSync(join(shimDir!, 'open'), [url], {
        env: scrubbedEnv,
        encoding: 'utf8'
      })
      expect(scrubbed.status).toBe(0)

      const env: Record<string, string> = {
        PATH: '/usr/bin:/bin',
        ORCA_CLI_BIN_DIR: cliBinDir
      }
      expect(
        applyMacosTerminalOpenShimEnv(env, {
          userDataPath: dir,
          cliLauncher: fakeCli,
          platform: 'darwin'
        })
      ).toBe(shimDir)
      expect(env.ORCA_CLI_BIN_DIR).toBe(shimDir)
      expect(buildMacosTerminalOpenShimScript(null)).toContain('exec /usr/bin/open "$@"')
    }
  )
})
