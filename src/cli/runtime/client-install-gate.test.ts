import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { awaitMacUpdateInstallMock, launchOrcaAppMock } = vi.hoisted(() => ({
  awaitMacUpdateInstallMock: vi.fn(),
  launchOrcaAppMock: vi.fn()
}))

vi.mock('./mac-update-install-gate', () => ({
  awaitMacUpdateInstall: awaitMacUpdateInstallMock
}))
vi.mock('./launch', () => ({ launchOrcaApp: launchOrcaAppMock }))

import { RuntimeClient, RuntimeClientError } from '../runtime-client'

type ClientInternals = {
  getCliStatus: () => Promise<unknown>
  remotePairing: unknown
}

const windowStatus = (status: string): { result: { app: { desktopWindowStatus: string } } } => ({
  result: { app: { desktopWindowStatus: status } }
})

const clientWithStatus = (...statuses: string[]): RuntimeClient => {
  const client = new RuntimeClient(undefined, 60_000, null, null, 'orca')
  const queue = [...statuses]
  const internals = client as unknown as ClientInternals
  internals.remotePairing = null
  internals.getCliStatus = () =>
    Promise.resolve(windowStatus(queue.length > 1 ? (queue.shift() as string) : queue[0]))
  return client
}

beforeEach(() => {
  awaitMacUpdateInstallMock.mockReset()
  launchOrcaAppMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('openOrca install gate', () => {
  it('launches normally when no install is in flight', async () => {
    awaitMacUpdateInstallMock.mockResolvedValue({ kind: 'proceed' })

    await clientWithStatus('available').openOrca()

    expect(launchOrcaAppMock).toHaveBeenCalledOnce()
  })

  it('does not launch a second instance after the installer swapped the app', async () => {
    // The installer relaunches Orca itself; launching here would create the extra instance that
    // blocks the NEXT update.
    awaitMacUpdateInstallMock.mockResolvedValue({ kind: 'installed', version: '1.4.195' })

    await clientWithStatus('available').openOrca()

    expect(launchOrcaAppMock).not.toHaveBeenCalled()
  })

  it('still launches when the installer never finished, rather than locking the user out', async () => {
    // Refusing to open Orca is a worse failure than a cancelled update.
    awaitMacUpdateInstallMock.mockResolvedValue({ kind: 'gave-up', targetVersion: '1.4.195' })

    await clientWithStatus('available').openOrca()

    expect(launchOrcaAppMock).toHaveBeenCalledOnce()
  })

  it('refuses rather than launching a target it could not check', async () => {
    awaitMacUpdateInstallMock.mockResolvedValue({ kind: 'untargetable-override' })

    await expect(clientWithStatus('available').openOrca()).rejects.toBeInstanceOf(
      RuntimeClientError
    )
    expect(launchOrcaAppMock).not.toHaveBeenCalled()
  })
})
