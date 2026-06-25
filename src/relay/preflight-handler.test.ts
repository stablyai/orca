import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn()
}))

vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return { execFile: execFileWithPromisify }
})

import {
  buildCommandLookupSpec,
  buildCommandLookupSpecs,
  hasAbsoluteCommandPath,
  isCommandOnPathForRelay
} from './preflight-handler'

function lookupArgs(command: string, mode: '-lc' | '-ilc' = '-lc'): string[] {
  return [
    mode,
    [
      `if resolved=$(command -v ${command} 2>/dev/null); then`,
      'printf \'__ORCA_AGENT_PATH__%s\\n\' "$resolved"',
      'fi'
    ].join('\n')
  ]
}

function fishLookupArgs(command: string): string[] {
  return [
    '-ilc',
    [
      `set -l resolved (command -v ${command} 2>/dev/null)`,
      'if test -n "$resolved"',
      'printf \'__ORCA_AGENT_PATH__%s\\n\' "$resolved"',
      'end'
    ].join('\n')
  ]
}

beforeEach(() => {
  execFileAsyncMock.mockReset()
})

describe('buildCommandLookupSpec', () => {
  it('uses where.exe on native Windows SSH hosts', () => {
    expect(buildCommandLookupSpec('codex', 'win32')).toEqual({
      file: 'where.exe',
      args: ['codex'],
      windowsHide: true
    })
  })

  it('falls back to sh for POSIX probes without a configured shell', () => {
    expect(buildCommandLookupSpec('codex', 'linux', {}, null)).toEqual({
      file: '/bin/sh',
      args: lookupArgs("'codex'")
    })
  })

  it('uses the configured remote shell for POSIX probes', () => {
    expect(buildCommandLookupSpec('codex', 'linux', { SHELL: '/bin/zsh' }, '/bin/zsh')).toEqual({
      file: '/bin/zsh',
      args: lookupArgs("'codex'", '-ilc')
    })
  })

  it('quotes command names in shell probes', () => {
    expect(
      buildCommandLookupSpec("agent'cli", 'linux', { SHELL: '/bin/bash' }, '/bin/bash')
    ).toEqual({
      file: '/bin/bash',
      args: lookupArgs("'agent'\\''cli'", '-ilc')
    })
  })
})

describe('buildCommandLookupSpecs', () => {
  it('falls back to inherited PATH after a trusted configured POSIX shell', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/bin/zsh' }, '/bin/zsh')).toEqual([
      { file: '/bin/zsh', args: lookupArgs("'codex'", '-ilc') },
      { file: '/bin/sh', args: lookupArgs("'codex'") }
    ])
  })

  it('allows a custom shell path only when the account login shell matches', () => {
    expect(
      buildCommandLookupSpecs(
        'codex',
        'darwin',
        { SHELL: '/opt/homebrew/bin/zsh' },
        '/opt/homebrew/bin/zsh'
      )
    ).toEqual([
      { file: '/opt/homebrew/bin/zsh', args: lookupArgs("'codex'", '-ilc') },
      { file: '/bin/sh', args: lookupArgs("'codex'") }
    ])
  })

  it('allows conservative system shell paths when account lookup is unavailable', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/usr/bin/bash' }, null)[0]).toEqual({
      file: '/usr/bin/bash',
      args: lookupArgs("'codex'", '-ilc')
    })
  })

  it('uses fish syntax for trusted fish shells', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/usr/bin/fish' }, null)[0]).toEqual({
      file: '/usr/bin/fish',
      args: fishLookupArgs("'codex'")
    })
  })

  it('ignores untrusted temp shell paths even when the basename is supported', () => {
    expect(buildCommandLookupSpecs('codex', 'linux', { SHELL: '/tmp/zsh' }, '/bin/bash')).toEqual([
      { file: '/bin/sh', args: lookupArgs("'codex'") }
    ])
  })

  it('ignores untrusted home-bin shell paths even when the basename is supported', () => {
    expect(
      buildCommandLookupSpecs('codex', 'linux', { SHELL: '/home/test/bin/bash' }, '/bin/bash')
    ).toEqual([{ file: '/bin/sh', args: lookupArgs("'codex'") }])
  })
})

describe('isCommandOnPathForRelay', () => {
  it('falls back to inherited PATH when shell startup returns no absolute command path', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'welcome\ncodex is a function\n' })
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      isCommandOnPathForRelay('codex', {
        platform: 'linux',
        env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
        accountLoginShell: '/bin/zsh'
      })
    ).resolves.toBe(true)
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      '/bin/zsh',
      lookupArgs("'codex'", '-ilc'),
      {
        encoding: 'utf-8',
        env: expect.objectContaining({ SHELL: '/bin/zsh' }),
        timeout: 5000
      }
    )
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, '/bin/sh', lookupArgs("'codex'"), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/bin/zsh' }),
      timeout: 5000
    })
  })

  it('falls back to inherited PATH when shell startup fails', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('startup failed'))
      .mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      isCommandOnPathForRelay('codex', {
        platform: 'linux',
        env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
        accountLoginShell: '/bin/bash'
      })
    ).resolves.toBe(true)
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not execute an untrusted configured shell before inherited PATH lookup', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '__ORCA_AGENT_PATH__/relay/path/codex\n' })

    await expect(
      isCommandOnPathForRelay('codex', {
        platform: 'linux',
        env: { SHELL: '/tmp/zsh', PATH: '/usr/bin' },
        accountLoginShell: '/bin/bash'
      })
    ).resolves.toBe(true)
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(execFileAsyncMock).toHaveBeenCalledWith('/bin/sh', lookupArgs("'codex'"), {
      encoding: 'utf-8',
      env: expect.objectContaining({ SHELL: '/tmp/zsh' }),
      timeout: 5000
    })
  })
})

describe('hasAbsoluteCommandPath', () => {
  it('ignores banners and shell function output', () => {
    expect(hasAbsoluteCommandPath('/tmp/not-the-agent\ncodex is a shell function\n', 'linux')).toBe(
      false
    )
  })

  it('ignores unmarked POSIX absolute paths from shell startup output', () => {
    expect(hasAbsoluteCommandPath('/tmp/not-the-agent\n', 'linux')).toBe(false)
  })

  it('recognizes a sentinel-marked command path amid shell startup and exit output', () => {
    expect(
      hasAbsoluteCommandPath('welcome\n__ORCA_AGENT_PATH__/opt/bin/codex\nlogout-banner\n', 'linux')
    ).toBe(true)
  })

  it('recognizes Windows absolute command paths', () => {
    expect(
      hasAbsoluteCommandPath('C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd\r\n', 'win32')
    ).toBe(true)
  })
})
