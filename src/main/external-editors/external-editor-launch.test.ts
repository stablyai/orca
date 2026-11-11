import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveCliCommandMock } = vi.hoisted(() => ({
  resolveCliCommandMock: vi.fn((command: string) => command)
}))

vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: resolveCliCommandMock
}))

import type { SshTarget } from '../../shared/ssh-types'
import { resolveExternalEditorLaunchSpec } from './external-editor-launch'
import { resolveRemoteSshEditorLaunchSpec } from './remote-ssh-editor-launch'

const BUILDER_ALIAS: SshTarget = {
  id: 'ssh-1',
  label: 'Builder',
  host: 'builder.example.com',
  port: 2222,
  username: 'ada',
  source: 'ssh-config',
  configHost: 'builder'
}

describe('resolveExternalEditorLaunchSpec', () => {
  beforeEach(() => {
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockImplementation((command: string) => command)
  })

  // start re-parses argv; reserve it for shims that need detachment.

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
})

describe('resolveRemoteSshEditorLaunchSpec', () => {
  beforeEach(() => {
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockImplementation((command: string) => command)
  })

  it('still requires an SSH config alias for a VS Code custom port', () => {
    const manualTarget: SshTarget = { ...BUILDER_ALIAS, source: 'manual', configHost: undefined }
    expect(
      resolveRemoteSshEditorLaunchSpec('code', '/srv/project', manualTarget, { platform: 'linux' })
    ).toEqual({ ok: false, reason: 'ssh-alias-required', host: 'builder.example.com', port: 2222 })
  })

  it.each(['subl', 'code --reuse-window', 'open -a "Visual Studio Code"'])(
    'rejects unsupported and compound SSH commands: %s',
    (command) => {
      expect(
        resolveRemoteSshEditorLaunchSpec(command, '/srv/project', BUILDER_ALIAS, {
          platform: 'linux'
        })
      ).toEqual({ ok: false, reason: 'remote-editor-unsupported' })
    }
  )
})
