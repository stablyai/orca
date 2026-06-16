import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resolveAgentForegroundProcess } from './agent-foreground-process'

// Why: the module wraps execFile with promisify, so the mock must honor the
// Node callback contract — invoke the last arg with (err, { stdout, stderr }).
function mockPs(stdout: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    callback(null, { stdout, stderr: '' })
  })
}

function windowsProcessRows(): string {
  return [
    'CommandLine=powershell.exe',
    'Name=powershell.exe',
    'ParentProcessId=99',
    'ProcessId=100',
    '',
    'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
    'Name=node.exe',
    'ParentProcessId=100',
    'ProcessId=101',
    ''
  ].join('\r\n')
}

describe('resolveAgentForegroundProcess', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('does not report a suspended agent when a non-agent holds the foreground', async () => {
    // shell pid 100. vim (pid 102) holds the terminal foreground ('+'); a
    // suspended codex (pid 101, stat 'T', no '+') is a backgrounded descendant.
    mockPs(
      [
        '101 100 T    node /Users/dev/.nvm/versions/node/bin/codex',
        '102 100 S+   vim notes.txt'
      ].join('\n')
    )

    await expect(resolveAgentForegroundProcess(100, 'vim')).resolves.toBe('vim')
  })

  it('still reports a foreground agent', async () => {
    mockPs(['101 100 S+   node /Users/dev/.nvm/versions/node/bin/codex'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'node')).resolves.toBe('codex')
  })

  it('does not report a stopped agent after the shell regains foreground', async () => {
    mockPs(
      ['100 99 Ss+  bash -i', '101 100 T    node /Users/dev/.nvm/versions/node/bin/codex'].join(
        '\n'
      )
    )

    await expect(resolveAgentForegroundProcess(100, 'bash')).resolves.toBe('bash')
  })

  it('falls back to recognized descendants when no process in the PTY tree holds foreground', async () => {
    // No '+' marker at all (e.g. a detached/daemon descendant tree) — the
    // recognized agent may still be the best available signal.
    mockPs(
      ['100 99 Ss   bash -i', '101 100 S    node /Users/dev/.nvm/versions/node/bin/codex'].join(
        '\n'
      )
    )

    await expect(resolveAgentForegroundProcess(100, 'node')).resolves.toBe('codex')
  })

  it('recognizes Windows wrapper-launched agents from descendant command lines', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, { stdout: windowsProcessRows(), stderr: '' })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('codex')
    expect(execFileMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function)
    )
  })

  it('falls back to WMIC when Windows PowerShell process enumeration fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      if (cmd === 'powershell.exe') {
        callback(new Error('powershell unavailable'), { stdout: '', stderr: '' })
        return
      }
      callback(null, { stdout: windowsProcessRows(), stderr: '' })
    })

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('codex')
    expect(execFileMock).toHaveBeenCalledWith(
      'wmic',
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function)
    )
  })

  it('does not use unrelated Windows agent descendants for wrapper fallbacks', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\repo\\server.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=codex',
            'Name=codex.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('node.exe')
  })

  it('fails closed when Windows has multiple matching wrapper descendants', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\repo\\server.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('node.exe')
  })

  it('does not enrich Windows foregrounds that are not interpreter wrappers', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    await expect(resolveAgentForegroundProcess(100, 'vim.exe')).resolves.toBe('vim.exe')
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
