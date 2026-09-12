import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  parseOrcadSlotRuntime,
  probeLegacyOrcadNativeDependenciesCommand,
  probeOrcadSlotRuntimeCommand
} from './orcad-slot-runtime-eligibility'

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+(\S+)/u)?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('orcad slot runtime eligibility', () => {
  it.each(['linux-x64', 'darwin-arm64'] as const)(
    'prefers bundled Bun and distinguishes complete legacy slots on %s',
    (platform) => {
      const command = probeOrcadSlotRuntimeCommand(
        getRemoteHostPlatform(platform),
        "/home/alice's box/orcad-old"
      )

      expect(command).toContain('bun-runtime')
      expect(command).toContain('LEGACY_NODE')
      expect(command).toContain('INCOMPLETE')
      expect(command).toContain('-x')
      // A present-but-non-executable Bun runtime must not be mistaken for a
      // pre-Bun Node slot during recovery.
      expect(command).toContain('-e')
    }
  )

  it('uses literal PowerShell paths for complete and incomplete Windows slots', () => {
    const command = decodePowerShellCommand(
      probeOrcadSlotRuntimeCommand(
        getRemoteHostPlatform('win32-x64'),
        "C:/Users/Alice's Box/orcad-old"
      )
    )

    expect(command).toContain("bun-runtime.exe' -PathType Leaf) { 'BUN' }")
    expect(command).toContain("bun-runtime') { 'INCOMPLETE' }")
    expect(command).not.toContain('Copy-Item')
    expect(command).not.toContain('Move-Item')
    expect(command).toContain('Test-Path -LiteralPath')
    expect(command).toContain('LEGACY_NODE')
    expect(command).toContain('INCOMPLETE')
  })

  it.each([
    ['BUN', 'bun'],
    ['LEGACY_NODE', 'legacy-node'],
    ['INCOMPLETE', 'incomplete'],
    ['banner only', 'incomplete']
  ] as const)('parses %s as %s', (output, expected) => {
    expect(parseOrcadSlotRuntime(output)).toBe(expected)
  })

  it.each(['linux-x64', 'win32-x64'] as const)(
    'proves legacy node-pty can load before launch on %s',
    (platform) => {
      const encodedCommand = probeLegacyOrcadNativeDependenciesCommand(
        getRemoteHostPlatform(platform),
        platform === 'win32-x64' ? 'C:/Orca/old' : '/home/alice/orca-old',
        platform === 'win32-x64' ? 'C:/Program Files/nodejs/node.exe' : '/usr/bin/node'
      )
      const command =
        platform === 'win32-x64' ? decodePowerShellCommand(encodedCommand) : encodedCommand

      expect(command).toContain('node-pty')
      expect(command).toContain('ORCAD_LEGACY_NATIVE_OK')
    }
  )
})
