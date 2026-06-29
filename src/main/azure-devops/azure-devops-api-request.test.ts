import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetAzCliTokenCache } from './az-cli-token'
import { authHeaders, resolveAzureDevOpsAuth } from './azure-devops-api-request'

const { execLocalPreflightCommandMock, isCommandAvailableMock } = vi.hoisted(() => ({
  execLocalPreflightCommandMock: vi.fn(),
  isCommandAvailableMock: vi.fn()
}))

vi.mock('../ipc/preflight-command-exec', () => ({
  execLocalPreflightCommand: execLocalPreflightCommandMock,
  isCommandAvailable: isCommandAvailableMock
}))

const OLD_ENV = process.env

describe('Azure DevOps API auth resolver', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN
    delete process.env.ORCA_AZURE_DEVOPS_PAT
    delete process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN
    delete process.env.ORCA_AZURE_DEVOPS_USERNAME
    execLocalPreflightCommandMock.mockReset()
    isCommandAvailableMock.mockReset()
    _resetAzCliTokenCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    _resetAzCliTokenCache()
  })

  it('prefers env access tokens without spawning az', async () => {
    process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN = 'env-access-token'

    await expect(resolveAzureDevOpsAuth()).resolves.toMatchObject({
      accessToken: 'env-access-token',
      source: 'env-token'
    })
    expect(execLocalPreflightCommandMock).not.toHaveBeenCalled()
  })

  it('prefers env PATs without spawning az', async () => {
    process.env.ORCA_AZURE_DEVOPS_TOKEN = 'env-pat'

    const auth = await resolveAzureDevOpsAuth()

    expect(auth).toMatchObject({ pat: 'env-pat', source: 'env-pat' })
    expect(authHeaders(auth).Authorization).toMatch(/^Basic /)
    expect(execLocalPreflightCommandMock).not.toHaveBeenCalled()
  })

  it('uses az CLI tokens as Bearer auth when env auth is absent', async () => {
    execLocalPreflightCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        accessToken: 'az-token',
        expires_on: Math.floor(Date.now() / 1000) + 3600
      }),
      stderr: ''
    })

    const auth = await resolveAzureDevOpsAuth()

    expect(auth).toMatchObject({ accessToken: 'az-token', source: 'az-cli' })
    expect(authHeaders(auth)).toEqual({ Authorization: 'Bearer az-token' })
  })

  it('returns source null and empty headers when no auth source is available', async () => {
    execLocalPreflightCommandMock.mockRejectedValue(new Error('not logged in'))

    const auth = await resolveAzureDevOpsAuth()

    expect(auth.source).toBeNull()
    expect(authHeaders(auth)).toEqual({})
  })
})
