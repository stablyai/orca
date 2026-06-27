import { describe, expect, it } from 'vitest'
import { getCmdExePath } from './win32-utils'
import { resolveExternalEditorLaunchSpec } from './external-editor-launch'

describe('resolveExternalEditorLaunchSpec', () => {
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
})
