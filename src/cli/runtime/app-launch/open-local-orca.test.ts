import { describe, expect, it, vi } from 'vitest'
import type { CliStatusResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeRpcSuccess } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { RuntimeClientError } from '../connection/types'
import { launchOrcaApp } from '../launch'
import { openLocalOrca } from './open-local-orca'

vi.mock('../launch', () => ({ launchOrcaApp: vi.fn() }))

const notRunning: RuntimeRpcSuccess<CliStatusResult> = {
  id: 'status',
  ok: true,
  _meta: { runtimeId: 'none' },
  result: {
    app: { running: false, pid: null },
    runtime: { reachable: false, state: 'not_running', runtimeId: null },
    graph: { state: 'not_running' }
  }
}
const running: RuntimeRpcSuccess<CliStatusResult> = {
  id: 'status',
  ok: true,
  _meta: { runtimeId: 'runtime' },
  result: {
    app: { running: true, pid: 42, desktopWindowStatus: 'available' },
    runtime: { reachable: true, state: 'ready', runtimeId: 'runtime' },
    graph: { state: 'ready' }
  }
}
const probeTimeout = new RuntimeClientError('runtime_timeout', 'Status probe timed out')

describe('orca open while the runtime is busy', () => {
  it('waits for the instance it launched to answer', async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(notRunning)
      .mockRejectedValueOnce(probeTimeout)
      .mockResolvedValue(running)

    await expect(openLocalOrca(readStatus, vi.fn(), 15_000)).resolves.toEqual(running)
  })

  it('opens the existing instance after it starts answering', async () => {
    vi.mocked(launchOrcaApp).mockClear()
    const readStatus = vi.fn().mockRejectedValueOnce(probeTimeout).mockResolvedValue(running)
    const openWindowInBackground = vi.fn().mockResolvedValue({ result: { requested: true } })

    await expect(openLocalOrca(readStatus, openWindowInBackground, 15_000)).resolves.toEqual(
      running
    )
    expect(openWindowInBackground).toHaveBeenCalled()
    expect(launchOrcaApp).not.toHaveBeenCalled()
  })
})
