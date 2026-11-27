import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareDevCliTerminalWrappers } from './dev-cli-terminal-wrapper.mjs'

it.skipIf(process.platform === 'win32')(
  'Windows development profiles resolve their own bare orca from Bash',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
    try {
      const repoRoot = join(root, "worktree's $release")
      const userDataPath = join(root, "profile's $release")
      const electronExecutable = join(repoRoot, 'electron.exe')
      const cli = join(repoRoot, 'out', 'cli', 'index.js')
      mkdirSync(dirname(cli), { recursive: true })
      writeFileSync(
        cli,
        'console.log(JSON.stringify({ args: process.argv.slice(2), profile: process.env.ORCA_USER_DATA_PATH, app: process.env.ORCA_APP_EXECUTABLE }))'
      )
      const installed = join(root, 'installed')
      mkdirSync(installed)
      writeFileSync(join(installed, 'orca'), '#!/usr/bin/env bash\necho installed\n', {
        mode: 0o755
      })

      const { userDataBinDir } = prepareDevCliTerminalWrappers({
        repoRoot,
        userDataPath,
        electronExecutable,
        platform: 'win32'
      })
      const args = [
        'bot',
        'reply',
        '--presentation-file',
        "regional sales's $report.json",
        '--prepare-final'
      ]
      const output = execFileSync('bash', ['-c', 'command -v orca; orca "$@"', 'qa', ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: [userDataBinDir, installed, dirname(process.execPath), process.env.PATH].join(
            delimiter
          )
        }
      })
      const [launcher, result] = output.trimEnd().split('\n')
      expect(launcher).toBe(join(userDataBinDir, 'orca'))
      expect(JSON.parse(result)).toEqual({ args, profile: userDataPath, app: electronExecutable })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
