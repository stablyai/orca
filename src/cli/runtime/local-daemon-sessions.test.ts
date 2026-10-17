import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../main/daemon/daemon-spawner'

const { ensureConnectedMock, ensureConnectedWithinMock, requestMock, disconnectMock } = vi.hoisted(
  () => ({
    ensureConnectedMock: vi.fn(),
    ensureConnectedWithinMock: vi.fn(),
    requestMock: vi.fn(),
    disconnectMock: vi.fn()
  })
)

vi.mock('../../main/daemon/client', () => ({
  DaemonClient: class {
    ensureConnected = ensureConnectedMock
    ensureConnectedWithin = ensureConnectedWithinMock
    request = requestMock
    disconnect = disconnectMock
  }
}))

import { getLocalDaemonStatus, stopAllLocalDaemonSessions } from './local-daemon-sessions'

function createUserDataWithEndpoint(): string {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-daemon-'))
  const runtimeDir = join(userDataPath, 'daemon')
  mkdirSync(runtimeDir)
  writeFileSync(getDaemonTokenPath(runtimeDir), 'token')
  if (process.platform !== 'win32') {
    writeFileSync(getDaemonSocketPath(runtimeDir), '')
  }
  return userDataPath
}

function endpointGoneError(): Error {
  return Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED',
    syscall: 'connect'
  })
}

function sessions(...ids: string[]): { sessions: { sessionId: string; isAlive: boolean }[] } {
  return { sessions: ids.map((sessionId) => ({ sessionId, isAlive: true })) }
}

beforeEach(() => {
  ensureConnectedMock.mockReset().mockResolvedValue(undefined)
  ensureConnectedWithinMock.mockReset().mockResolvedValue(undefined)
  requestMock.mockReset()
  disconnectMock.mockReset()
})

describe('getLocalDaemonStatus', () => {
  it('reports no daemon when the endpoint files are absent', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-daemon-'))

    await expect(getLocalDaemonStatus(userDataPath)).resolves.toEqual({
      reachable: false,
      sessionCount: 0
    })
    expect(ensureConnectedWithinMock).not.toHaveBeenCalled()
  })

  it('reports zero sessions when nothing listens on the endpoint', async () => {
    ensureConnectedWithinMock.mockRejectedValueOnce(endpointGoneError())

    await expect(getLocalDaemonStatus(createUserDataWithEndpoint())).resolves.toEqual({
      reachable: false,
      sessionCount: 0
    })
  })

  it('reports an unknown count when the connection fails for another reason', async () => {
    ensureConnectedWithinMock.mockRejectedValueOnce(new Error('Connection timed out'))

    await expect(getLocalDaemonStatus(createUserDataWithEndpoint())).resolves.toEqual({
      reachable: false,
      sessionCount: null
    })
    expect(disconnectMock).toHaveBeenCalled()
  })

  it('keeps a connected daemon reachable when listing sessions fails', async () => {
    requestMock.mockRejectedValueOnce(new Error('Request listSessions timed out'))

    await expect(getLocalDaemonStatus(createUserDataWithEndpoint())).resolves.toEqual({
      reachable: true,
      sessionCount: null
    })
  })

  it('bounds the connect and list calls with one status budget', async () => {
    requestMock.mockResolvedValueOnce(sessions('a', 'b'))

    await expect(getLocalDaemonStatus(createUserDataWithEndpoint())).resolves.toEqual({
      reachable: true,
      sessionCount: 2
    })
    expect(ensureConnectedMock).not.toHaveBeenCalled()
    expect(ensureConnectedWithinMock).toHaveBeenCalledWith(1000)
    const listTimeoutMs = requestMock.mock.calls[0][2]
    expect(listTimeoutMs).toBeGreaterThan(0)
    expect(listTimeoutMs).toBeLessThanOrEqual(1000)
  })
})

describe('stopAllLocalDaemonSessions', () => {
  it('is a no-op when nothing listens on the endpoint', async () => {
    ensureConnectedMock.mockRejectedValueOnce(endpointGoneError())

    await expect(stopAllLocalDaemonSessions(createUserDataWithEndpoint())).resolves.toEqual({
      stopped: 0,
      remaining: 0
    })
  })

  it('fails when the daemon endpoint exists but cannot be connected', async () => {
    ensureConnectedMock.mockRejectedValueOnce(new Error('Hello response timed out'))

    await expect(stopAllLocalDaemonSessions(createUserDataWithEndpoint())).rejects.toMatchObject({
      code: 'daemon_unavailable'
    })
    expect(disconnectMock).toHaveBeenCalled()
  })

  it('fails when the initial session list cannot be read', async () => {
    requestMock.mockRejectedValueOnce(new Error('Connection lost'))

    await expect(stopAllLocalDaemonSessions(createUserDataWithEndpoint())).rejects.toMatchObject({
      code: 'daemon_request_failed'
    })
  })

  it('reports every session stopped once the daemon no longer lists them', async () => {
    requestMock.mockImplementation(async (type: string) =>
      type === 'listSessions' ? sessions() : {}
    )
    requestMock.mockResolvedValueOnce(sessions('a', 'b'))

    await expect(stopAllLocalDaemonSessions(createUserDataWithEndpoint())).resolves.toEqual({
      stopped: 2,
      remaining: 0
    })
  })

  it('keeps the last observed count when the daemon is lost while settling', async () => {
    requestMock.mockImplementation(async (type: string) => {
      if (type === 'listSessions') {
        throw new Error('Connection lost')
      }
      return {}
    })
    requestMock.mockResolvedValueOnce(sessions('a', 'b'))

    await expect(stopAllLocalDaemonSessions(createUserDataWithEndpoint())).resolves.toEqual({
      stopped: 0,
      remaining: 2
    })
  })
})
