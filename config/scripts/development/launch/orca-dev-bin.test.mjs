import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '../../../..')
describe('orca-dev package bin', () => {
  it('finds the built CLI from its installed location when invoked outside the repository', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-dev-installed-'))
    try {
      for (const file of [
        'config/scripts/development/launch/orca-dev.mjs',
        'config/scripts/development/launch/dev-cli-terminal-wrapper.mjs',
        'config/scripts/development/instance-isolation/dev-instance-isolation.mjs'
      ]) {
        const target = path.join(root, file)
        mkdirSync(path.dirname(target), { recursive: true })
        copyFileSync(path.join(projectDir, file), target)
      }
      const cliEntry = path.join(root, 'out', 'cli', 'index.js')
      mkdirSync(path.dirname(cliEntry), { recursive: true })
      writeFileSync(
        cliEntry,
        'console.log(JSON.stringify({argv: process.argv.slice(2), userDataPath: process.env.ORCA_USER_DATA_PATH}))'
      )
      const userDataPath = path.join(root, 'profile')
      const stdout = execFileSync(
        process.execPath,
        [path.join(root, 'config/scripts/development/launch/orca-dev.mjs'), '--help'],
        {
          cwd: path.dirname(root),
          env: {
            ...process.env,
            ORCA_DEV_CLI_ENTRY_PATH: undefined,
            ORCA_DEV_USER_DATA_PATH: userDataPath,
            ORCA_APP_EXECUTABLE: path.join(root, 'Electron')
          },
          encoding: 'utf8'
        }
      )
      expect(JSON.parse(stdout)).toEqual({ argv: ['--help'], userDataPath })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
