import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  orcadBashStdioBridgeCommand,
  orcadPosixStdioBridgeCommand
} from '../managed-server/lifecycle/orcad-stdio-bridge-script'
import type { OrcadHostTransport } from './orcad-host-transport'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { resolveOrcadStdioBridge } from './orcad-stdio-bridge'

const detect = vi.hoisted(() => vi.fn())
vi.mock('./ssh-remote-platform-detection', () => ({ detectRemoteHostPlatform: detect }))

function transport(target: ReturnType<OrcadHostTransport['getTarget']>): OrcadHostTransport {
  const refuse = (): never => {
    throw new Error('no remote command expected')
  }
  return {
    getTarget: () => target,
    exec: refuse,
    usesSystemSshTransport: () => false,
    getConnectGeneration: () => 0,
    writeFile: refuse,
    uploadDirectory: refuse
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('resolving the stdio bridge', () => {
  it('uses the bash bridge for a WSL distro without probing its platform again', async () => {
    const bridge = await resolveOrcadStdioBridge(
      transport({ kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' }),
      6768
    )
    expect(bridge).toEqual({
      command: orcadBashStdioBridgeCommand(6768),
      mode: 'raw',
      wrapCommand: true
    })
    expect(detect).not.toHaveBeenCalled()
  })

  it('still probes an SSH host before choosing its bridge', async () => {
    detect.mockResolvedValue(getRemoteHostPlatform('linux-x64'))
    const bridge = await resolveOrcadStdioBridge(
      transport({ id: 'ssh-1', label: 'box', host: 'box', port: 22, username: 'me' }),
      6768
    )
    expect(detect).toHaveBeenCalledOnce()
    expect(bridge.mode).toBe('raw')
    expect(bridge.command).toBe(orcadPosixStdioBridgeCommand(6768))
  })

  it('refuses an SSH host whose platform it cannot serve', async () => {
    detect.mockResolvedValue(null)
    await expect(
      resolveOrcadStdioBridge(
        transport({ id: 'ssh-1', label: 'box', host: 'box', port: 22, username: 'me' }),
        6768
      )
    ).rejects.toThrow('doesn’t support this SSH host’s platform')
  })
})
