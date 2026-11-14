import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ViewerFixture = {
  displayName: string
  email: string | null
  organizationId: string
  organizationName: string
  organizationUrlKey: string
}

let tempHome = ''
let fixtures = new Map<string, ViewerFixture>()
let linearClientMock: ReturnType<typeof vi.fn>

type SafeStorageMockOptions = {
  encryptionAvailable?: boolean
  decryptString?: (value: Buffer) => string
}

function writeLegacyLinearFiles(token: string, viewer: Record<string, unknown>): void {
  writeLegacyLinearToken(token, viewer)
}

function writeLegacyLinearToken(token: string | Buffer, viewer: Record<string, unknown>): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(join(orcaDir, 'linear-token.enc'), token)
  writeFileSync(join(orcaDir, 'linear-viewer.json'), JSON.stringify(viewer), {
    encoding: 'utf-8'
  })
}

function workspaceTokenPath(workspaceId: string): string {
  return join(
    tempHome,
    '.orca',
    'linear-tokens',
    `${Buffer.from(workspaceId).toString('base64url')}.enc`
  )
}

function writeMultiWorkspaceFiles(
  workspaces: { id: string; token: string | Buffer; credentialRevision?: number }[],
  selectedWorkspaceId: string
): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(join(orcaDir, 'linear-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'linear-workspaces.json'),
    JSON.stringify({
      version: 1,
      activeWorkspaceId: workspaces[0]?.id ?? null,
      selectedWorkspaceId,
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        organizationId: workspace.id,
        organizationName: workspace.id,
        displayName: 'Ada',
        email: 'ada@example.com',
        credentialRevision: workspace.credentialRevision
      }))
    }),
    { encoding: 'utf-8' }
  )
  for (const workspace of workspaces) {
    writeFileSync(workspaceTokenPath(workspace.id), workspace.token)
  }
}

async function loadClientModule(options: SafeStorageMockOptions = {}) {
  vi.resetModules()
  linearClientMock = vi.fn(function LinearClient(
    this: { viewer: Promise<unknown> },
    { apiKey }: { apiKey: string }
  ) {
    const fixture = fixtures.get(apiKey)
    if (!fixture) {
      throw new Error('Invalid API key')
    }
    this.viewer = Promise.resolve({
      displayName: fixture.displayName,
      email: fixture.email,
      organization: Promise.resolve({
        id: fixture.organizationId,
        name: fixture.organizationName,
        urlKey: fixture.organizationUrlKey
      })
    })
  })
  const { setSecretStore } = await import('../../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => options.encryptionAvailable ?? false,
    encryptString: (value) => Buffer.from(value),
    decryptString: options.decryptString ?? ((value) => value.toString('utf-8')),
    describeProtectionGap: () => null
  })
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  class AuthenticationLinearError extends Error {}
  // Mock the lazy loader; createRequire bypasses mocks on the raw SDK module.
  vi.doMock('../requests/linear-sdk', () => ({
    createLinearClient: (options: { apiKey: string }) => new linearClientMock(options),
    loadLinearSdk: () => ({
      AuthenticationLinearError,
      LinearClient: linearClientMock
    })
  }))

  return import('./linear-account-client')
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-linear-client-')
  fixtures = new Map([
    [
      'token-alpha',
      {
        displayName: 'Ada',
        email: 'ada@example.com',
        organizationId: 'org-alpha',
        organizationName: 'Alpha',
        organizationUrlKey: 'alpha'
      }
    ],
    [
      'token-beta',
      {
        displayName: 'Grace',
        email: 'grace@example.com',
        organizationId: 'org-beta',
        organizationName: 'Beta',
        organizationUrlKey: 'beta'
      }
    ]
  ])
  vi.restoreAllMocks()
})

function mkdtempLike(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('Linear workspace file cross-process visibility', () => {
  it('recovers a token that appears after metadata was first read without it', async () => {
    writeMultiWorkspaceFiles([{ id: 'ws-alpha', token: 'token-alpha' }], 'ws-alpha')
    const path = workspaceTokenPath('ws-alpha')
    rmSync(path)
    const linear = await loadClientModule()
    expect(linear.getStatus().connected).toBe(false)
    writeFileSync(path, 'token-alpha')
    expect(linear.getStatus().connected).toBe(true)
    expect(linear.getClients('ws-alpha')).toHaveLength(1)
  })

  it('refreshes legacy Linear credentials when another process replaces or removes the token', async () => {
    writeLegacyLinearFiles('token-alpha', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule()
    expect(linear.getClients('legacy')[0]?.apiKey).toBe('token-alpha')
    const path = join(tempHome, '.orca', 'linear-token.enc')
    writeFileSync(path, 'token-beta')
    expect(linear.getClients('legacy')[0]?.apiKey).toBe('token-beta')
    rmSync(path)
    expect(linear.getStatus().connected).toBe(false)
    expect(linear.getClients('legacy')).toEqual([])
  })
})
