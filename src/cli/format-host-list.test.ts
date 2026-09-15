import { describe, expect, it } from 'vitest'
import { formatHostList } from './format'

describe('formatHostList', () => {
  it('names the twin row on both sides and says which selector to prefer', () => {
    const text = formatHostList({
      hosts: [
        {
          kind: 'local',
          name: 'this machine',
          id: 'local',
          selector: '--host local',
          platform: 'darwin'
        },
        {
          kind: 'ssh',
          name: 'vaish@mini',
          id: 'ssh-1',
          selector: '--host ssh:ssh-1',
          platform: 'darwin',
          connected: false,
          connectionStatus: 'reconnecting',
          sameMachineAs: { kind: 'environment', name: 'mini', selector: '--environment mini' }
        },
        {
          kind: 'environment',
          name: 'mini',
          id: 'env-1',
          selector: '--environment mini',
          platform: 'darwin',
          sameMachineAs: { kind: 'ssh', name: 'vaish@mini', selector: '--host ssh:ssh-1' }
        }
      ]
    })
    const [local, ssh, server] = text.split('\n')
    expect(local).not.toContain('same machine')
    expect(ssh).toContain('not connected (reconnecting)  ->  --host ssh:ssh-1')
    expect(ssh).toContain('same machine as orca server "mini"; prefer --environment mini')
    expect(server).toContain('->  --environment mini  (same machine as ssh target "vaish@mini")')
  })

  it('prints rows without a twin exactly as before', () => {
    const text = formatHostList({
      hosts: [{ kind: 'environment', name: 'lab', id: 'env-2', selector: '--environment lab' }]
    })
    expect(text).toBe('orca server lab  platform unknown    ->  --environment lab')
  })
})
