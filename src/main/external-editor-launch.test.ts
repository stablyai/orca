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
      spawnCmd: '/bin/sh',
      spawnArgs: ['-c', "open -a \"Typora\" '/tmp/note'\\''s.md'"]
    })
  })

  it('runs compound Windows commands through cmd.exe', () => {
    expect(
      resolveExternalEditorLaunchSpec('start "" notepad', 'C:\\note.md', { platform: 'win32' })
    ).toEqual({
      kind: 'shell',
      spawnCmd: getCmdExePath(),
      spawnArgs: ['/d', '/s', '/c', 'start "" notepad C:\\note.md']
    })
  })

  it('quotes Windows paths with spaces in compound commands', () => {
    expect(
      resolveExternalEditorLaunchSpec('start "" notepad', 'C:\\my notes.md', { platform: 'win32' })
    ).toEqual({
      kind: 'shell',
      spawnCmd: getCmdExePath(),
      spawnArgs: ['/d', '/s', '/c', 'start "" notepad "C:\\my notes.md"']
    })
  })
})
