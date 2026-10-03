import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ViewerFixture = {
  id?: string
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
  workspaces: { id: string; token: string | Buffer }[],
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
        email: 'ada@example.com'
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
  vi.doMock('../orca-profiles/profile-index-store', () => ({
    getOrcaProfileListState: () => ({ activeProfileId: 'profile-a' })
  }))
  linearClientMock = vi.fn(function LinearClient(
    this: { viewer: Promise<unknown> },
    { apiKey }: { apiKey: string }
  ) {
    const fixture = fixtures.get(apiKey)
    if (!fixture) {
      throw new Error('Invalid API key')
    }
    this.viewer = Promise.resolve({
      id: fixture.id ?? `viewer-${fixture.organizationId}`,
      displayName: fixture.displayName,
      email: fixture.email,
      organization: Promise.resolve({
        id: fixture.organizationId,
        name: fixture.organizationName,
        urlKey: fixture.organizationUrlKey
      })
    })
  })
  const { setSecretStore } = await import('../../shared/secret-store')
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
  // Why: client.ts loads @linear/sdk lazily via ./linear-sdk (createRequire) to
  // keep it off the startup parse path; mock the loader, not the raw module.
  vi.doMock('./linear-sdk', () => ({
    loadLinearSdk: () => ({
      AuthenticationLinearError,
      LinearClient: linearClientMock
    })
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
  it('never migrates a legacy token over an explicitly connected workspace', async () => {
    writeLegacyLinearFiles('token-alpha', {
      displayName: 'Legacy',
      email: 'legacy@example.com',
      organizationName: 'Alpha'
    })
    fixtures.set('token-new', { ...fixtures.get('token-alpha')!, id: 'new-viewer' })
    const linear = await loadClientModule()
    await linear.connect('token-new')
    const saved = linear.getStatus().workspaces?.find((entry) => entry.id === 'org-alpha')
    await expect(linear.testConnection('legacy')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('already connected')
    })
    expect(linear.getStatus().workspaces?.find((entry) => entry.id === 'org-alpha')).toBe(saved)
    expect(readFileSync(workspaceTokenPath('org-alpha'), 'utf-8')).toBe('token-new')
  })

  it('persists the verified viewer only on explicit connect', async () => {
    const linear = await loadClientModule()
    await linear.connect('token-alpha')
    expect(linear.getStatus().workspaces?.[0]).toMatchObject({
      viewerId: 'viewer-org-alpha',
      credentialOwnerProfileId: 'profile-a',
      credentialEpoch: expect.any(String),
      credentialRevision: 1
    })
    fixtures.set('token-alpha', { ...fixtures.get('token-alpha')!, id: 'different-viewer' })
    await expect(linear.testConnection('org-alpha')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('identity changed')
    })
    expect(linear.getStatus().workspaces?.[0]?.viewerId).toBe('viewer-org-alpha')
    await linear.connect('token-alpha')
    expect(linear.getStatus().workspaces?.[0]).toMatchObject({
      viewerId: 'different-viewer',
      credentialRevision: 2
    })
  })

  it('rejects changed organizations without replacing the stored workspace', async () => {
    const linear = await loadClientModule()
    await linear.connect('token-alpha')
    fixtures.set('token-alpha', { ...fixtures.get('token-alpha')!, organizationId: 'other-org' })
    await expect(linear.testConnection('org-alpha')).resolves.toMatchObject({ ok: false })
    expect(linear.getStatus().workspaces?.map((entry) => entry.id)).toEqual(['org-alpha'])
  })

  it('preserves viewer metadata across disk reload and clears revoked tokens', async () => {
    let linear = await loadClientModule()
    await linear.connect('token-alpha')
    const epoch = linear.getStatus().workspaces?.[0]?.credentialEpoch
    linear = await loadClientModule()
    expect(linear.getStatus().workspaces?.[0]).toMatchObject({
      viewerId: 'viewer-org-alpha',
      credentialEpoch: epoch
    })
    const { loadLinearSdk } = await import('./linear-sdk')
    linearClientMock.mockImplementationOnce(function () {
      throw new (loadLinearSdk().AuthenticationLinearError)()
    })
    await expect(linear.testConnection('org-alpha')).resolves.toMatchObject({ ok: false })
    expect(linear.getStatus().connected).toBe(false)
  })

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
    expect(status.workspaces?.[0]?.viewerId).toBeUndefined()
    expect(existsSync(join(tempHome, '.orca', 'linear-token.enc'))).toBe(false)
    expect(readFileSync(join(tempHome, '.orca', 'linear-workspaces.json'), 'utf-8')).toContain(
      'org-alpha'
    )
  })

  it('preserves plaintext legacy token fallback when safeStorage cannot decrypt it', async () => {
    writeLegacyLinearFiles('token-alpha', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('not encrypted')
      }
    })

    await expect(linear.testConnection('legacy')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha', organizationName: 'Alpha' }
    })

    expect(linearClientMock).toHaveBeenCalledWith({ apiKey: 'token-alpha' })
  })

  it('does not pass encrypted safeStorage bytes to the Linear SDK when encryption is unavailable', async () => {
    const tokenPath = join(tempHome, '.orca', 'linear-token.enc')
    writeLegacyLinearToken(Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]), {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({ encryptionAvailable: false })

    await expect(linear.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.'
    })

    expect(linearClientMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(linear.getStatus()).toMatchObject({
      connected: true,
      credentialError:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.',
      workspaces: [{ id: 'legacy' }]
    })
  })

  it('does not clear the Linear token when safeStorage decryption fails', async () => {
    const tokenPath = join(tempHome, '.orca', 'linear-token.enc')
    writeLegacyLinearToken(Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]), {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    await expect(linear.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.'
    })

    expect(linearClientMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(linear.getStatus()).toMatchObject({
      connected: true,
      credentialError:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.',
      workspaces: [{ id: 'legacy' }]
    })
  })

  it('clears the recorded credential error after Keychain access is approved', async () => {
    let keychainApproved = false
    writeLegacyLinearToken(Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]), {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        if (!keychainApproved) {
          throw new Error('userCanceledErr')
        }
        return 'token-alpha'
      }
    })

    await expect(linear.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.'
    })
    expect(linear.getStatus().credentialError).toContain('Could not decrypt')

    keychainApproved = true
    await expect(linear.testConnection('legacy')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha', organizationName: 'Alpha' }
    })
    expect(linear.getStatus().credentialError).toBeUndefined()
  })

  it('treats empty Linear token files as missing credentials', async () => {
    writeLegacyLinearToken(Buffer.alloc(0), {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({ encryptionAvailable: false })

    await expect(linear.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error: 'No API key stored.'
    })

    expect(linearClientMock).not.toHaveBeenCalled()
    expect(linear.getStatus()).toMatchObject({ connected: false })
  })

  it('keeps healthy workspaces under the "all" selection when one cannot be decrypted', async () => {
    writeMultiWorkspaceFiles(
      [
        { id: 'good', token: 'token-good' },
        { id: 'bad', token: Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]) }
      ],
      'all'
    )
    fixtures.set('token-good', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationId: 'good',
      organizationName: 'good',
      organizationUrlKey: 'good'
    })
    const linear = await loadClientModule({
      encryptionAvailable: true,
      // Why: the plaintext "token-good" falls back through the legacy path;
      // the binary "bad" token throws CredentialDecryptionError.
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    const clients = linear.getClients('all')
    expect(clients.map((client) => client.workspace.id)).toEqual(['good'])
    expect(linear.getStatus().credentialError).toContain('Could not decrypt')
  })

  it('rethrows the decrypt error for a specific workspace selection', async () => {
    writeMultiWorkspaceFiles(
      [
        { id: 'good', token: 'token-good' },
        { id: 'bad', token: Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]) }
      ],
      'bad'
    )
    const linear = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    expect(() => linear.getClients('bad')).toThrow('Could not decrypt')
  })
})
