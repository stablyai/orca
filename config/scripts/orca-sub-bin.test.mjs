import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
const wrapperPath = path.join(projectDir, 'config', 'scripts', 'orca-sub.mjs')

describe('orca-sub package bin', () => {
  it('declares a dedicated Node entrypoint without taking over the orca command', () => {
    expect(packageJson.bin.orca).toBe('./out/cli/index.js')
    expect(packageJson.bin['orca-sub']).toBe('./config/scripts/orca-sub.mjs')
    expect(readFileSync(wrapperPath, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/)
  })

  it('keeps build:cli responsible for installing the local orca-sub entry', () => {
    expect(packageJson.scripts['build:cli']).toContain('config/scripts/install-sub-cli.mjs')
  })

  it('routes one natural-language context into mission start through the dev CLI runtime', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-bin-'))
    const cliEntry = path.join(root, 'cli-entry.cjs')
    const outputPath = path.join(root, 'output.json')
    writeFileSync(
      cliEntry,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({`,
        '  argv: process.argv.slice(2),',
        '  userDataPath: process.env.ORCA_USER_DATA_PATH,',
        '  devCliInvocation: process.env.ORCA_DEV_CLI_INVOCATION',
        '}));'
      ].join('\n'),
      'utf8'
    )
    if (process.platform !== 'win32') {
      chmodSync(cliEntry, 0o755)
    }

    execFileSync(process.execPath, [wrapperPath, 'inspect mission routing', '--agent', 'pi'], {
      env: {
        ...process.env,
        ORCA_DEV_CLI_ENTRY_PATH: cliEntry,
        ORCA_DEV_USER_DATA_PATH: path.join(root, 'user-data'),
        ORCA_APP_EXECUTABLE: path.join(root, 'Electron')
      },
      stdio: 'ignore'
    })

    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
      argv: ['mission', 'start', '--text', 'inspect mission routing', '--agent', 'pi'],
      userDataPath: path.join(root, 'user-data'),
      devCliInvocation: '1'
    })
  })
})
