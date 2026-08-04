import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalizePathThroughFilesystemHost,
  FilesystemHostReadAuthority,
  setFilesystemHostReadClientForTests
} from './filesystem-host-read-authority'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import { resolveCliCommandThroughFilesystemHost } from './filesystem-host-rate-limit-client'

afterEach(() => {
  setFilesystemHostReadClientForTests(null)
})

type TestSupervisor = NonNullable<
  ConstructorParameters<typeof FilesystemHostReadAuthority>[0]['supervisor']
>

function createSupervisor(dispatch: ReturnType<typeof vi.fn>): TestSupervisor {
  return {
    dispatch: dispatch as TestSupervisor['dispatch'],
    publishFailureDomain: vi.fn(),
    removeFailureDomain: vi.fn(),
    dispose: vi.fn(async () => {})
  }
}

describe('FilesystemHostReadAuthority', () => {
  it('fails closed before production configuration', async () => {
    setFilesystemHostReadClientForTests(null)
    await expect(canonicalizePathThroughFilesystemHost('/repo')).rejects.toMatchObject({
      name: 'FilesystemHostReadError',
      code: 'EHOSTUNREACH',
      reason: 'unavailable'
    })
    await expect(resolveCliCommandThroughFilesystemHost('codex')).resolves.toBe('codex')
  })

  it('routes WSL and UNC paths to Windows-host lanes', async () => {
    const dispatch = vi.fn(async (input) => ({
      kind: 'canonicalize-path' as const,
      canonicalPath: input.operation.path
    }))
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      platform: 'win32',
      supervisor: createSupervisor(dispatch)
    })

    await authority.canonicalizePath('\\\\wsl.localhost\\Ubuntu\\home\\repo')
    await authority.canonicalizePath('\\\\server\\share\\repo')

    expect(dispatch.mock.calls[0][0]).toMatchObject({
      executionHost: 'windows-host',
      storageClass: 'wsl',
      admission: 'foreground'
    })
    expect(dispatch.mock.calls[1][0]).toMatchObject({
      executionHost: 'windows-host',
      storageClass: 'unc',
      admission: 'foreground'
    })
  })

  it.each(['//server/share/repo', '//wsl.localhost/Ubuntu/home/repo'])(
    'keeps POSIX double-slash path %s on the native host',
    async (path) => {
      const dispatch = vi.fn(async (input) => ({
        kind: 'canonicalize-path' as const,
        canonicalPath: input.operation.path
      }))
      const authority = new FilesystemHostReadAuthority({
        entryPath: '/unused',
        platform: 'darwin',
        supervisor: createSupervisor(dispatch)
      })

      await authority.canonicalizePath(path)

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ executionHost: 'native', storageClass: 'workspace' })
      )
    }
  )

  it('maps domain and deadline failures to compatible Node error codes', async () => {
    const denied = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(
        vi.fn(async () => {
          throw new FilesystemHostSupervisorError('operation', 'denied', 'denied')
        })
      )
    })
    const timedOut = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(
        vi.fn(async () => {
          throw new FilesystemHostSupervisorError('deadline', 'timeout')
        })
      )
    })

    await expect(denied.canonicalizePath('/repo')).rejects.toMatchObject({ code: 'EACCES' })
    await expect(timedOut.canonicalizePath('/repo')).rejects.toEqual(
      expect.objectContaining({
        code: 'ETIMEDOUT',
        reason: 'deadline'
      })
    )
  })

  it('routes keybinding hydration as a bounded home read', async () => {
    const dispatch = vi.fn(async () => ({
      kind: 'read-keybindings' as const,
      contents: '{"version":1}'
    }))
    const supervisor = createSupervisor(dispatch)
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor
    })

    await expect(authority.readKeybindings('/home/alice/.orca/keybindings.json')).resolves.toBe(
      '{"version":1}'
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: 'read-keybindings' }),
        storageClass: 'home',
        admission: 'foreground'
      })
    )
  })

  it('runs keybinding migration and cohort seeding inside the filesystem child', async () => {
    const dispatch = vi.fn(async () => ({
      kind: 'prepare-keybindings' as const,
      contents: '{"version":1}',
      seedCompleted: true
    }))
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(dispatch)
    })

    await expect(
      authority.prepareKeybindings(
        '/home/alice/.orca/keybindings.json',
        'linux',
        { 'tab.nextAllTypes': ['Mod+K'] },
        true
      )
    ).resolves.toEqual({ contents: '{"version":1}', seedCompleted: true })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: 'prepare-keybindings',
          platform: 'linux',
          seedLegacyTabSwitchBindings: true
        }),
        storageClass: 'home',
        admission: 'foreground'
      })
    )
  })

  it('routes snapshot files and PTY cwd preparation through bounded typed operations', async () => {
    const dispatch = vi.fn(async (input) =>
      input.operation.kind === 'read-snapshot-file'
        ? {
            kind: 'read-snapshot-file' as const,
            contentsBase64: Buffer.from('token').toString('base64')
          }
        : {
            kind: 'prepare-rate-limit-pty-cwd' as const,
            canonicalPath: input.operation.path
          }
    )
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(dispatch)
    })

    await expect(
      authority.readSnapshotFile('/home/alice/.grok/auth.json', 'grok-auth')
    ).resolves.toEqual(Buffer.from('token'))
    await expect(authority.prepareRateLimitPtyCwd('/profile/rate-limit-pty-cwd')).resolves.toBe(
      '/profile/rate-limit-pty-cwd'
    )
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      operation: { kind: 'read-snapshot-file', fileKind: 'grok-auth' },
      storageClass: 'home',
      admission: 'background'
    })
    expect(dispatch.mock.calls[1][0]).toMatchObject({
      operation: { kind: 'prepare-rate-limit-pty-cwd' },
      storageClass: 'user-data',
      admission: 'background'
    })
  })

  it('classifies known prefixes away from dispatch and publishes their device lanes', async () => {
    const publishFailureDomain = vi.fn()
    const dispatch = vi.fn(async () => ({ kind: 'classify-path' as const, deviceId: 'device-7' }))
    const supervisor = {
      ...createSupervisor(dispatch),
      publishFailureDomain
    }
    const authority = new FilesystemHostReadAuthority({ entryPath: '/unused', supervisor })

    authority.hydrateFailureDomains(['/repo', '/repo'])
    await vi.waitFor(() => expect(publishFailureDomain).toHaveBeenCalledTimes(1))

    expect(publishFailureDomain).toHaveBeenCalledWith({
      executionHost: 'native',
      prefix: '/repo',
      mountId: 'device-7'
    })

    authority.hydrateFailureDomains(['/repo'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('bounds hydration without dropping repositories beyond lane capacity', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let active = 0
    let maximumActive = 0
    const dispatch = vi.fn(async () => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await gate
      active--
      return { kind: 'classify-path' as const, deviceId: 'device-7' }
    })
    const publishFailureDomain = vi.fn()
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: { ...createSupervisor(dispatch), publishFailureDomain }
    })
    const paths = Array.from({ length: 100 }, (_, index) => `/repo-${index}`)

    authority.hydrateFailureDomains(paths)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(4))
    expect(maximumActive).toBe(4)
    release()

    await vi.waitFor(() => expect(publishFailureDomain).toHaveBeenCalledTimes(100))
    expect(dispatch).toHaveBeenCalledTimes(100)
  })

  it('classifies a startup repo burst while prior classifier children are still exiting', async () => {
    const startProcess = vi.fn(async (options: { onPhysicalExit?: () => void }) => ({
      invoke: async (operation: { kind: string }) =>
        operation.kind === 'classify-path'
          ? ({ kind: 'classify-path', deviceId: 'device-7' } as const)
          : ({ kind: 'read-orca-yaml', contents: 'scripts: {}\n' } as const),
      retire: async () =>
        await new Promise<boolean>((resolve) => {
          setTimeout(() => {
            options.onPhysicalExit?.()
            resolve(true)
          }, 20)
        })
    }))
    const supervisor = new FilesystemHostSupervisor({
      entryPath: '/unused',
      maximumChildren: 8,
      startProcess
    })
    const publishFailureDomain = vi.spyOn(supervisor, 'publishFailureDomain')
    const authority = new FilesystemHostReadAuthority({ entryPath: '/unused', supervisor })
    const repoPaths = Array.from({ length: 30 }, (_, index) => `/repo-${index}`)

    authority.hydrateFailureDomains(['/home', '/user-data'])
    authority.reconcileFailureDomains(repoPaths)
    const reads = await Promise.allSettled(
      repoPaths.map((path) => authority.readOrcaYaml(`${path}/orca.yaml`))
    )

    expect(reads.every((result) => result.status === 'fulfilled')).toBe(true)
    await vi.waitFor(() => expect(publishFailureDomain).toHaveBeenCalledTimes(32))
    await authority.dispose()
  })

  it('retries catalog classification after transient child capacity exhaustion', async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new FilesystemHostSupervisorError('capacity', 'full'))
      .mockResolvedValueOnce({ kind: 'classify-path' as const, deviceId: 'device-7' })
    const supervisor = createSupervisor(dispatch)
    const authority = new FilesystemHostReadAuthority({ entryPath: '/unused', supervisor })

    authority.reconcileFailureDomains(['/repo'])

    await vi.waitFor(() => expect(supervisor.publishFailureDomain).toHaveBeenCalledOnce())
    expect(dispatch).toHaveBeenCalledTimes(2)
    await authority.dispose()
  })

  it('does not recreate capacity retries after disposal', async () => {
    const dispatch = vi.fn(async () => {
      await Promise.resolve()
      throw new FilesystemHostSupervisorError('capacity', 'full')
    })
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(dispatch)
    })

    authority.reconcileFailureDomains(['/repo'])
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    await authority.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('cancels obsolete queued classifications when the catalog is replaced', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatch = vi.fn(async () => {
      await gate
      return { kind: 'classify-path' as const, deviceId: 'device-7' }
    })
    const supervisor = createSupervisor(dispatch)
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor
    })
    const paths = Array.from({ length: 100 }, (_, index) => `/repo-${index}`)

    authority.reconcileFailureDomains(paths)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(4))
    authority.reconcileFailureDomains([])
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dispatch).toHaveBeenCalledTimes(4)
    expect(supervisor.publishFailureDomain).not.toHaveBeenCalled()
  })

  it('classifies orca.yaml once before routing repeated reads', async () => {
    const dispatch = vi.fn(async (input) =>
      input.operation.kind === 'classify-path'
        ? { kind: 'classify-path' as const, deviceId: 'device-7' }
        : { kind: 'read-orca-yaml' as const, contents: 'scripts: {}\n' }
    )
    const supervisor = createSupervisor(dispatch)
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor
    })
    authority.reconcileFailureDomains(['/repo'])
    await vi.waitFor(() => expect(supervisor.publishFailureDomain).toHaveBeenCalledTimes(1))

    await authority.readOrcaYaml('/repo/orca.yaml')
    await authority.readOrcaYaml('/repo/orca.yaml')

    expect(dispatch.mock.calls.map(([input]) => input.operation.kind)).toEqual([
      'classify-path',
      'read-orca-yaml',
      'read-orca-yaml'
    ])
  })

  it('prunes removed catalog classifications and reclassifies re-added paths', async () => {
    const dispatch = vi.fn(async () => ({
      kind: 'classify-path' as const,
      deviceId: 'device-7'
    }))
    const supervisor = createSupervisor(dispatch)
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor
    })

    authority.reconcileFailureDomains(['/repo'])
    await vi.waitFor(() => expect(supervisor.publishFailureDomain).toHaveBeenCalledTimes(1))
    authority.reconcileFailureDomains([])
    expect(supervisor.removeFailureDomain).toHaveBeenCalledWith({
      executionHost: 'native',
      prefix: '/repo'
    })

    authority.reconcileFailureDomains(['/repo'])
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
  })

  it('resolves CLI commands through a typed bounded home operation', async () => {
    const dispatch = vi.fn(async () => ({
      kind: 'resolve-cli-command' as const,
      command: '/managed/bin/codex'
    }))
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(dispatch)
    })

    await expect(authority.resolveCliCommand('codex')).resolves.toBe('/managed/bin/codex')
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: 'resolve-cli-command', commandName: 'codex' }),
        storageClass: 'home',
        admission: 'background'
      })
    )
  })

  it('writes rate-limit credentials through a typed bounded home operation', async () => {
    const dispatch = vi.fn(async () => ({
      kind: 'write-rate-limit-credential' as const
    }))
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(dispatch)
    })

    await authority.writeRateLimitCredential(
      '/home/alice/.gemini/oauth_creds.json',
      'gemini-oauth-credentials',
      '{"access_token":"access","refresh_token":"refresh","expiry_date":123}'
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: 'write-rate-limit-credential' }),
        storageClass: 'home',
        admission: 'background',
        deadlineMs: 20_000
      })
    )
  })
})
