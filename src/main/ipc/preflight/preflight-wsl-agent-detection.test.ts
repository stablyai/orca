import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectWslCommandsOnPath } from './preflight-wsl-agent-detection'
import '../../../shared/shell/command-resolution/posix-command-path-lookup'

describe('the detection script itself, run by a real POSIX shell', () => {
  // Execute real shell globbing and executable checks; Windows has no /bin/sh.
  const itPosix = process.platform === 'win32' ? it.skip : it
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-wsl-detect-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const plant = (dir: string, name: string): void => {
    mkdirSync(join(home, dir), { recursive: true })
    const file = join(home, dir, name)
    writeFileSync(file, '#!/bin/sh\necho hi\n')
    chmodSync(file, 0o755)
  }

  const runScript = async (): Promise<string> => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: false,
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['orca-fake-cli', 'nosuchtool'])
    const script = String(runWslProcessMock.mock.calls.at(-1)?.[0].script)
    const options: ExecFileSyncOptions = {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin' }
    }
    return String(execFileSync('/bin/sh', ['-c', script], options))
  }

  itPosix('finds an nvm-installed binary the login PATH would have shown', async () => {
    // Version-manager fallback must recover a CLI absent from login PATH (#9725).
    plant('.nvm/versions/node/v20.1.0/bin', 'orca-fake-cli')
    const out = await runScript()
    expect(out).toContain('__ORCA_AGENT_PATH__orca-fake-cli')
    expect(out).toContain('.nvm/versions/node/v20.1.0/bin/orca-fake-cli')
  })

  itPosix('finds a CLI when $HOME contains a space', async () => {
    // HOME with spaces must remain one path throughout fallback glob expansion.
    const spaced = mkdtempSync(join(tmpdir(), 'orca has space-'))
    const previous = home
    home = spaced
    try {
      plant('.nvm/versions/node/v20.1.0/bin', 'orca-fake-cli')
      expect(await runScript()).toContain(`${spaced}/.nvm/versions/node/v20.1.0/bin/orca-fake-cli`)
    } finally {
      home = previous
      rmSync(spaced, { recursive: true, force: true })
    }
  })

  itPosix('does not report a directory as an installed CLI', async () => {
    // Directories pass -x but would fail to launch with EISDIR.
    mkdirSync(join(home, '.local/bin/orca-fake-cli'), { recursive: true })
    expect(await runScript()).not.toContain('__ORCA_AGENT_PATH__orca-fake-cli')
  })
})
