import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveCliCommandMock } = vi.hoisted(() => ({
  resolveCliCommandMock: vi.fn((command: string) => command)
}))

vi.mock('./codex-cli/command', () => ({
  resolveCliCommand: resolveCliCommandMock
}))

import { getCmdExePath } from './win32-utils'
import {
  resolveExternalEditorLaunchSpec,
  resolveVsCodeRemoteSshLaunchSpec
} from './external-editor-launch'

describe('resolveExternalEditorLaunchSpec', () => {
  beforeEach(() => {
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockImplementation((command: string) => command)
  })

  it('keeps simple CLI commands on the executable launch path', () => {
    const spec = resolveExternalEditorLaunchSpec('cursor', '/tmp/workspace', {
      platform: 'darwin'
    })
    expect(spec).toEqual({
      kind: 'executable',
      hideWindowsConsole: true,
      spawnCmd: expect.any(String),
      spawnArgs: ['--new-window', '/tmp/workspace']
    })
  })

  it('appends escaped paths to compound macOS open commands', () => {
    expect(
      resolveExternalEditorLaunchSpec('open -a "Typora"', "/tmp/note's.md", {
        platform: 'darwin'
      })
    ).toEqual({
      kind: 'shell',
      hideWindowsConsole: true,
      spawnCmd: '/bin/sh',
      spawnArgs: ['-c', "open -a \"Typora\" '/tmp/note'\\''s.md'"]
    })
  })

  it('treats an existing POSIX executable path with spaces as an executable launcher', () => {
    const ideaPath = '/Users/me/Library/Application Support/JetBrains/Toolbox/scripts/idea'
    expect(
      resolveExternalEditorLaunchSpec(ideaPath, '/tmp/workspace', {
        platform: 'darwin',
        fileExists: (candidate) => candidate === ideaPath
      })
    ).toEqual({
      kind: 'executable',
      hideWindowsConsole: true,
      spawnCmd: ideaPath,
      spawnArgs: ['/tmp/workspace']
    })
  })

  it('keeps absolute POSIX commands with arguments on the shell launch path', () => {
    expect(
      resolveExternalEditorLaunchSpec('/usr/local/bin/code --reuse-window', '/tmp/workspace', {
        platform: 'darwin',
        fileExists: () => false
      })
    ).toEqual({
      kind: 'shell',
      hideWindowsConsole: true,
      spawnCmd: '/bin/sh',
      spawnArgs: ['-c', '/usr/local/bin/code --reuse-window /tmp/workspace']
    })
  })

  it('runs compound Windows commands through cmd.exe', () => {
    expect(
      resolveExternalEditorLaunchSpec('start "" notepad', 'C:\\note.md', { platform: 'win32' })
    ).toEqual({
      kind: 'shell',
      hideWindowsConsole: true,
      spawnCmd: getCmdExePath(),
      spawnArgs: ['/d', '/s', '/c', 'start "" notepad C:\\note.md']
    })
  })

  it('quotes Windows paths with spaces in compound commands', () => {
    expect(
      resolveExternalEditorLaunchSpec('start "" notepad', 'C:\\my notes.md', { platform: 'win32' })
    ).toEqual({
      kind: 'shell',
      hideWindowsConsole: true,
      spawnCmd: getCmdExePath(),
      spawnArgs: ['/d', '/s', '/c', 'start "" notepad "C:\\my notes.md"']
    })
  })

  it('treats unquoted Windows executable paths with spaces as executable launchers', () => {
    expect(
      resolveExternalEditorLaunchSpec(
        'C:\\Program Files\\Neovim\\bin\\nvim.exe',
        'C:\\workspaces\\orca',
        { platform: 'win32' }
      )
    ).toEqual({
      kind: 'executable',
      hideWindowsConsole: false,
      spawnCmd: 'C:\\Program Files\\Neovim\\bin\\nvim.exe',
      spawnArgs: ['C:\\workspaces\\orca']
    })
  })

  it('treats quoted Windows executable paths with spaces as executable launchers', () => {
    expect(
      resolveExternalEditorLaunchSpec(
        '"C:\\Program Files\\Neovim\\bin\\nvim.exe"',
        'C:\\workspaces\\orca',
        { platform: 'win32' }
      )
    ).toEqual({
      kind: 'executable',
      hideWindowsConsole: false,
      spawnCmd: 'C:\\Program Files\\Neovim\\bin\\nvim.exe',
      spawnArgs: ['C:\\workspaces\\orca']
    })
  })

  it('shows the Windows console for NeoVim shell commands with arguments', () => {
    expect(
      resolveExternalEditorLaunchSpec('nvim --clean', 'C:\\workspaces\\orca', {
        platform: 'win32'
      })
    ).toEqual({
      kind: 'shell',
      hideWindowsConsole: false,
      spawnCmd: getCmdExePath(),
      spawnArgs: ['/d', '/s', '/c', 'nvim --clean C:\\workspaces\\orca']
    })
  })

  it.each(['code', 'code-insiders'])(
    'opens modern WSL UNC workspaces with %s in the matching VS Code remote',
    (editorCommand) => {
      expect(
        resolveExternalEditorLaunchSpec(
          editorCommand,
          '\\\\wsl.localhost\\Ubuntu\\home\\aliuq\\project',
          { platform: 'win32' }
        ).spawnArgs
      ).toEqual(['--remote', 'wsl+Ubuntu', '/home/aliuq/project'])
    }
  )

  it.each([
    [
      'legacy WSL UNC workspace',
      '\\\\wsl$\\Debian\\home\\ada\\project',
      'wsl+Debian',
      '/home/ada/project'
    ],
    ['modern WSL distro root', '\\\\wsl.localhost\\Ubuntu', 'wsl+Ubuntu', '/'],
    ['legacy WSL distro root', '\\\\wsl$\\Debian', 'wsl+Debian', '/']
  ])('opens a %s in the matching VS Code remote', (_label, pathValue, authority, linuxPath) => {
    expect(
      resolveExternalEditorLaunchSpec('code', pathValue, { platform: 'win32' }).spawnArgs
    ).toEqual(['--remote', authority, linuxPath])
  })

  it.each([
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe',
    'C:\\Tools\\CODE.CMD',
    'C:\\Tools\\code.bat',
    'C:\\Tools\\code-insiders.cmd'
  ])('recognizes the direct Windows VS Code launcher %s', (editorCommand) => {
    expect(
      resolveExternalEditorLaunchSpec(
        editorCommand,
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\project',
        { platform: 'win32' }
      ).spawnArgs
    ).toEqual(['--remote', 'wsl+Ubuntu', '/home/ada/project'])
  })

  it.each([
    ['code', 'C:\\Tools\\CODE.CMD'],
    ['code', 'C:\\Tools\\code.bat'],
    ['code-insiders', 'C:\\Tools\\code-insiders.cmd']
  ])('recognizes the resolved Windows VS Code launcher %s', (editorCommand, resolvedCommand) => {
    resolveCliCommandMock.mockReturnValueOnce(resolvedCommand)

    expect(
      resolveExternalEditorLaunchSpec(
        editorCommand,
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\project',
        { platform: 'win32' }
      )
    ).toEqual({
      kind: 'executable',
      hideWindowsConsole: true,
      spawnCmd: resolvedCommand,
      spawnArgs: ['--remote', 'wsl+Ubuntu', '/home/ada/project']
    })
  })

  it('preserves spaces in WSL distro and folder arguments', () => {
    expect(
      resolveExternalEditorLaunchSpec(
        'code',
        '\\\\wsl.localhost\\Ubuntu Preview\\home\\Ada Lovelace\\project',
        { platform: 'win32' }
      ).spawnArgs
    ).toEqual(['--remote', 'wsl+Ubuntu Preview', '/home/Ada Lovelace/project'])
  })

  it.each(['darwin', 'linux'] as const)('keeps WSL-looking paths local on %s', (platform) => {
    const pathValue = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\project'
    expect(resolveExternalEditorLaunchSpec('code', pathValue, { platform }).spawnArgs).toEqual([
      pathValue
    ])
  })

  it.each(['C:\\workspaces\\orca', '\\\\server\\share\\project'])(
    'keeps the non-WSL Windows path %s local',
    (pathValue) => {
      expect(
        resolveExternalEditorLaunchSpec('code', pathValue, { platform: 'win32' }).spawnArgs
      ).toEqual([pathValue])
    }
  )

  it('does not add VS Code remote arguments to other editors', () => {
    const pathValue = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\project'

    expect(
      resolveExternalEditorLaunchSpec('C:\\Tools\\cursor.exe', pathValue, {
        platform: 'win32'
      }).spawnArgs
    ).toEqual(['--new-window', pathValue])
    expect(
      resolveExternalEditorLaunchSpec('C:\\Tools\\codium.exe', pathValue, {
        platform: 'win32'
      }).spawnArgs
    ).toEqual([pathValue])
  })

  it('does not rewrite compound VS Code commands', () => {
    const pathValue = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\project'

    expect(
      resolveExternalEditorLaunchSpec('code --reuse-window', pathValue, { platform: 'win32' })
    ).toEqual({
      kind: 'shell',
      hideWindowsConsole: true,
      spawnCmd: getCmdExePath(),
      spawnArgs: ['/d', '/s', '/c', `code --reuse-window ${pathValue}`]
    })
  })
})

describe('resolveVsCodeRemoteSshLaunchSpec', () => {
  beforeEach(() => {
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockImplementation((command: string) => command)
  })

  it.each(['code', 'code-insiders'])('builds exact Remote-SSH arguments for %s', (command) => {
    expect(
      resolveVsCodeRemoteSshLaunchSpec(command, '/home/Ada Lovelace/project', 'builder', {
        platform: 'linux'
      })
    ).toEqual({
      kind: 'executable',
      hideWindowsConsole: true,
      spawnCmd: command,
      spawnArgs: ['--remote', 'ssh-remote+builder', '/home/Ada Lovelace/project']
    })
  })

  it.each([
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe',
    'C:\\Tools\\code.cmd',
    'C:\\Tools\\code-insiders.bat'
  ])('supports the direct Windows launcher %s', (command) => {
    expect(
      resolveVsCodeRemoteSshLaunchSpec(command, 'C:\\Users\\Ada Lovelace\\project', 'builder', {
        platform: 'win32'
      })?.spawnArgs
    ).toEqual(['--remote', 'ssh-remote+builder', 'C:\\Users\\Ada Lovelace\\project'])
  })

  it('supports an existing direct POSIX launcher path containing spaces', () => {
    const command = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
    expect(
      resolveVsCodeRemoteSshLaunchSpec(command, '/srv/project', 'builder', {
        platform: 'darwin',
        fileExists: (candidate) => candidate === command
      })
    ).toMatchObject({
      kind: 'executable',
      spawnCmd: command,
      spawnArgs: ['--remote', 'ssh-remote+builder', '/srv/project']
    })
  })

  it('recognizes a simple CLI name resolved to a Windows shim', () => {
    resolveCliCommandMock.mockReturnValueOnce('C:\\Tools\\Code.CMD')
    expect(
      resolveVsCodeRemoteSshLaunchSpec('code', '/srv/project', 'builder', {
        platform: 'win32'
      })
    ).toMatchObject({ spawnCmd: 'C:\\Tools\\Code.CMD' })
  })

  it.each(['cursor', 'zed', 'code --reuse-window', 'open -a "Visual Studio Code"'])(
    'rejects unsupported and compound SSH commands: %s',
    (command) => {
      expect(
        resolveVsCodeRemoteSshLaunchSpec(command, '/srv/project', 'builder', {
          platform: 'linux'
        })
      ).toBeNull()
    }
  )
})
