import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
const wrapperPath = path.join(projectDir, 'config', 'scripts', 'orca-dev.mjs')

describe('orca-dev package bin', () => {
  it('uses a Node entrypoint for cross-platform package installs', () => {
    expect(packageJson.bin['orca-dev']).toBe('./config/scripts/orca-dev.mjs')
    expect(readFileSync(wrapperPath, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/)
  })

  it('runs the dev CLI through Node without requiring Bash', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-dev-bin-'))
    const cliEntry = path.join(root, 'cli-entry.cjs')
    const outputPath = path.join(root, 'output.json')
    writeFileSync(
      cliEntry,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({`,
        '  argv: process.argv.slice(2),',
        '  userDataPath: process.env.ORCA_USER_DATA_PATH,',
        '  appExecutable: process.env.ORCA_APP_EXECUTABLE',
        '}));'
      ].join('\n'),
      'utf8'
    )
    if (process.platform !== 'win32') {
      chmodSync(cliEntry, 0o755)
    }

    execFileSync(process.execPath, [wrapperPath, '--help'], {
      env: {
        ...process.env,
        ORCA_DEV_CLI_ENTRY_PATH: cliEntry,
        ORCA_DEV_USER_DATA_PATH: path.join(root, 'user-data'),
        ORCA_APP_EXECUTABLE: path.join(root, 'Electron')
      },
      stdio: 'ignore'
    })

    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
      argv: ['--help'],
      userDataPath: path.join(root, 'user-data'),
      appExecutable: path.join(root, 'Electron')
    })
  })
})
