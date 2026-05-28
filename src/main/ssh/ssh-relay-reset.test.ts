import { describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))

import { forceStopRelayForTarget } from './ssh-relay-reset'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import type { SshConnection } from './ssh-connection'

describe('forceStopRelayForTarget', () => {
  it('targets only the relay socket for the requested SSH target', async () => {
    const conn = {} as SshConnection

    await forceStopRelayForTarget(conn, 'ssh-1')

    const command = vi.mocked(execCommand).mock.calls[0]?.[1] ?? ''
    expect(execCommand).toHaveBeenCalledWith(conn, expect.any(String))
    expect(command).toContain(`sock_name='${relaySocketNameForInstanceId('ssh-1')}'`)
    expect(command).toContain('lsof -t -U "$sock"')
    expect(command).toContain('pgrep -f "$sock_name"')
    expect(command).toContain('rm -f "$sock"')
  })
})
