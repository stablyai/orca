import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type * as Os from 'os'
import { join } from 'path'
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

function writeLegacyLinearFiles(token: string, viewer: Record<string, unknown>): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(join(orcaDir, 'linear-token.enc'), token, { encoding: 'utf-8' })
  writeFileSync(join(orcaDir, 'linear-viewer.json'), JSON.stringify(viewer), {
    encoding: 'utf-8'
  })
}

async function loadClientModule() {
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
  vi.doMock('electron', () => ({
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString('utf-8')
    }
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  vi.doMock('@linear/sdk', () => ({
    AuthenticationLinearError: class AuthenticationLinearError extends Error {},
    LinearClient: linearClientMock
  }))

  return import('./client')
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

describe('Linear client workspace storage', () => {
  it('stores multiple workspaces and remembers the selected workspace', async () => {
    const linear = await loadClientModule()

    await expect(linear.connect('token-alpha')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha', organizationName: 'Alpha' }
    })
    await expect(linear.connect('token-beta')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-beta', organizationName: 'Beta' }
    })

    expect(linear.getStatus()).toMatchObject({
      connected: true,
      selectedWorkspaceId: 'org-beta',
      workspaces: [
        { id: 'org-alpha', organizationName: 'Alpha' },
        { id: 'org-beta', organizationName: 'Beta' }
      ]
    })

    expect(linear.selectWorkspace('all')).toMatchObject({ selectedWorkspaceId: 'all' })

    linear.disconnect('org-alpha')
    expect(linear.getStatus()).toMatchObject({
      connected: true,
      workspaces: [{ id: 'org-beta', organizationName: 'Beta' }]
    })
  })

  it('reports a legacy single-token workspace without constructing a Linear client', async () => {
    writeLegacyLinearFiles('token-alpha', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule()

    expect(linear.getStatus()).toMatchObject({
      connected: true,
      selectedWorkspaceId: 'legacy',
      workspaces: [{ id: 'legacy', organizationName: 'Alpha', isLegacy: true }]
    })
    expect(linearClientMock).not.toHaveBeenCalled()
  })

  it('migrates legacy token storage to a real workspace id when explicitly tested', async () => {
    writeLegacyLinearFiles('token-alpha', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule()

    await expect(linear.testConnection('legacy')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha', organizationName: 'Alpha' }
    })

    const status = linear.getStatus()
    expect(status).toMatchObject({
      connected: true,
      selectedWorkspaceId: 'org-alpha',
      workspaces: [{ id: 'org-alpha', organizationName: 'Alpha' }]
    })
    expect(status.workspaces?.some((workspace) => workspace.id === 'legacy')).toBe(false)
    expect(existsSync(join(tempHome, '.orca', 'linear-token.enc'))).toBe(false)
    expect(readFileSync(join(tempHome, '.orca', 'linear-workspaces.json'), 'utf-8')).toContain(
      'org-alpha'
    )
  })
})
