import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { RelayPlatform } from '../ssh/relay-protocol'
import { remoteSessionSources } from './remote-session-scanner-sources'

function devinRootDir(relayPlatform: RelayPlatform, remoteHome: string): string | undefined {
  const hostPlatform: RemoteHostPlatform = getRemoteHostPlatform(relayPlatform)
  return remoteSessionSources(remoteHome, hostPlatform).find((source) => source.agent === 'devin')
    ?.rootDir
}

describe('remoteSessionSources devin transcripts root', () => {
  it.each([
    {
      relayPlatform: 'win32-x64' as const,
      remoteHome: 'C:/Users/dev',
      expected: 'C:/Users/dev/AppData/Roaming/devin/cli/transcripts'
    },
    {
      relayPlatform: 'linux-x64' as const,
      remoteHome: '/home/dev',
      expected: '/home/dev/.local/share/devin/cli/transcripts'
    },
    {
      relayPlatform: 'darwin-arm64' as const,
      remoteHome: '/Users/dev',
      expected: '/Users/dev/.local/share/devin/cli/transcripts'
    }
  ])('resolves $expected on $relayPlatform', ({ relayPlatform, remoteHome, expected }) => {
    expect(devinRootDir(relayPlatform, remoteHome)).toBe(expected)
  })
})
