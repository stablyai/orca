import { describe, expect, it } from 'vitest'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'
import { withRemoteRuntimeTailscaleHint } from '../../../shared/remote-runtime-tailscale-hint'

const UNREACHABLE = 'Could not connect to the remote Orca runtime at ws://127.0.0.1:42000.'

describe('withRuntimeUnreachableHint', () => {
  it('points a WSL host at its own reconnect, never at Tailscale', () => {
    const message = withRuntimeUnreachableHint(
      { orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 } },
      UNREACHABLE,
      'ws://127.0.0.1:42000'
    )
    expect(message).not.toMatch(/tailscale/i)
    expect(message).toContain('The Orca server in the WSL distro Ubuntu isn’t answering')
  })

  it('keeps the Tailscale hint for a network server', () => {
    expect(withRuntimeUnreachableHint({}, UNREACHABLE, 'ws://203.0.113.4:6768')).toMatch(
      /tailscale/i
    )
  })

  it('leaves other failures alone', () => {
    const wsl = {
      orcadDeployment: { kind: 'wsl' as const, distro: 'Ubuntu', localPort: 1, remotePort: 2 }
    }
    expect(withRuntimeUnreachableHint(wsl, 'Unauthorized', null)).toBe('Unauthorized')
  })

  it.each([
    ['a paired server', {}],
    [
      'a legacy SSH-managed server',
      { orcadDeployment: { sshTargetId: 't', sshTargetGeneration: 1, localPort: 1, remotePort: 2 } }
    ],
    [
      'an SSH-managed server',
      {
        orcadDeployment: {
          kind: 'ssh' as const,
          sshTargetId: 't',
          sshTargetGeneration: 1,
          localPort: 1,
          remotePort: 2
        }
      }
    ]
  ])('gives %s exactly the Tailscale hint', (_name, environment) => {
    expect(withRuntimeUnreachableHint(environment, UNREACHABLE, 'ws://203.0.113.4:6768')).toBe(
      withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://203.0.113.4:6768')
    )
  })

  it('pins the full WSL hint text', () => {
    expect(
      withRuntimeUnreachableHint(
        { orcadDeployment: { kind: 'wsl', distro: 'Debian', localPort: 1, remotePort: 2 } },
        'Timed out waiting for the remote Orca runtime.',
        null
      )
    ).toBe(
      'Timed out waiting for the remote Orca runtime. The Orca server in the WSL distro Debian isn’t answering; connect it again in Settings → Remote Orca Servers → WSL hosts.'
    )
  })
})
