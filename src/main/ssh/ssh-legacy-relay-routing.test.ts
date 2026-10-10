import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const { previousRelayCensus, readRelayDaemonRuntimes, open } = vi.hoisted(() => ({
  previousRelayCensus: vi.fn(),
  readRelayDaemonRuntimes: vi.fn(),
  open: vi.fn()
}))

vi.mock('./ssh-previous-relay-terminals', () => ({ previousRelayCensus }))
vi.mock('./ssh-relay-endpoint-runtime', () => ({ readRelayDaemonRuntimes }))
vi.mock('./ssh-legacy-relay-route', () => ({ SshLegacyRelayRoute: { open } }))

import { createSshLegacyRelayRouter, listPreviousRelayPtyIds } from './ssh-legacy-relay-routing'

const OLD_SOCK = '/home/dev/.orca-remote/relay-1.4.0/relay-abc.sock'
const CURRENT_NODE = '/home/dev/.orca-remote/node-runtimes/v24/bin/node'
// The routing only hands the connection to the mocked runtime read and route.
const conn: SshConnection = Object.create(null)

function router() {
  return createSshLegacyRelayRouter({
    targetId: 'target-1',
    connection: () => conn,
    clientInstanceId: 'client-1',
    sink: { data: vi.fn(), exit: vi.fn(), replay: vi.fn() }
  })
}

describe('the legacy relay route runtime', () => {
  beforeEach(() => {
    previousRelayCensus.mockReset().mockResolvedValue({
      endpoints: [OLD_SOCK],
      nodePath: CURRENT_NODE,
      status: 'complete',
      bridgeable: true
    })
    readRelayDaemonRuntimes.mockReset()
    open.mockReset().mockResolvedValue(null)
  })

  it('opens an older relay’s bridge on the runtime that relay runs on', async () => {
    const olderPin = '/home/dev/.orca-remote/node-runtimes/v22/bin/node'
    readRelayDaemonRuntimes.mockResolvedValue(new Map([[OLD_SOCK, olderPin]]))

    await router().listHeld()

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ sockPath: OLD_SOCK, nodePath: olderPin })
    )
  })

  it('falls back to the current deploy’s runtime when the daemon’s argv is unreadable', async () => {
    readRelayDaemonRuntimes.mockResolvedValue(new Map())

    await router().listHeld()

    expect(open).toHaveBeenCalledWith(expect.objectContaining({ nodePath: CURRENT_NODE }))
  })

  it('holds a live Windows pipe without trying to bridge it', async () => {
    previousRelayCensus.mockResolvedValue({
      endpoints: ['C:\\Users\\dev\\.orca-remote\\relay-0.1.0+aaa'],
      nodePath: CURRENT_NODE,
      status: 'complete',
      bridgeable: false
    })

    await expect(router().listHeld()).resolves.toEqual([])
    await expect(listPreviousRelayPtyIds('target-1')).resolves.toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})
