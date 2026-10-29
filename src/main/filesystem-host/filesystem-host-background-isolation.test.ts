import { expect, it, vi } from 'vitest'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import { FilesystemHostReadAuthority } from './filesystem-host-read-authority'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'

it.each(['catalog', 'writes'] as const)(
  'keeps healthy background reads moving while four slow %s requests are outstanding',
  async (workload) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocked = vi.fn()
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess: async (options) => ({
        invoke: async (operation) => {
          if (operation.path.startsWith('/slow')) {
            blocked()
            await gate
          }
          switch (operation.kind) {
            case 'classify-path':
              return { kind: 'classify-path', deviceId: 'healthy' }
            case 'write-rate-limit-credential':
              return { kind: 'write-rate-limit-credential' }
            case 'read-orca-yaml':
              return { kind: 'read-orca-yaml', contents: 'scripts: {}' }
            case 'read-snapshot-file':
              return {
                kind: 'read-snapshot-file',
                contentsBase64: Buffer.from('healthy').toString('base64')
              }
            default:
              throw new Error(`Unexpected operation ${operation.kind}`)
          }
        },
        retire: async () => {
          options.onPhysicalExit?.()
          return true
        }
      })
    })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/slow', mountId: 'slow' })
    supervisor.publishFailureDomain({
      executionHost: 'native',
      prefix: '/healthy',
      mountId: 'healthy'
    })
    const authority = new FilesystemHostReadAuthority({ entryPath: 'unused', supervisor })
    let writes: Promise<void>[] = []
    try {
      if (workload === 'catalog') {
        // The healthy path starts fifth in catalog admission; the read must promote it.
        authority.reconcileFailureDomains(['/slow/a', '/slow/b', '/slow/c', '/slow/d', '/healthy'])
        await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(4))
      } else {
        writes = Array.from({ length: 4 }, () =>
          authority.writeRateLimitCredential(
            '/slow/oauth_creds.json',
            'gemini-oauth-credentials',
            '{}'
          )
        )
        await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce())
      }
      await expect(authority.readSnapshotFile('/healthy/auth', 'grok-auth')).resolves.toEqual(
        Buffer.from('healthy')
      )
      await expect(authority.readOrcaYaml('/healthy/orca.yaml')).resolves.toBe('scripts: {}')
      expect(supervisor.health().physicalChildren).toBeLessThanOrEqual(8)
    } finally {
      release()
      await Promise.all(writes)
      await authority.dispose()
    }
  }
)

it('retries overflowed catalog classifications after bounded admission drains', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const publishFailureDomain = vi.fn()
  const authority = new FilesystemHostReadAuthority({
    entryPath: 'unused',
    supervisor: {
      dispatch: async () => {
        await gate
        return { kind: 'classify-path', deviceId: 'disk' }
      },
      publishFailureDomain,
      removeFailureDomain: vi.fn(),
      dispose: async () => {}
    }
  })
  try {
    authority.reconcileFailureDomains(Array.from({ length: 140 }, (_, index) => `/repo-${index}`))
    await vi.advanceTimersByTimeAsync(0)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(publishFailureDomain).toHaveBeenCalledTimes(132)
    await vi.advanceTimersByTimeAsync(25)
    expect(publishFailureDomain).toHaveBeenCalledTimes(140)
  } finally {
    release()
    await authority.dispose()
    vi.useRealTimers()
  }
})

it('retains catalog retry ownership when a promoted read classification hits capacity', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let attempts = 0
  const publishFailureDomain = vi.fn()
  const authority = new FilesystemHostReadAuthority({
    entryPath: 'unused',
    supervisor: {
      dispatch: async ({ operation }) => {
        if (operation.kind === 'read-orca-yaml') {
          return { kind: 'read-orca-yaml', contents: 'scripts: {}' }
        }
        if (operation.path === '/healthy') {
          attempts++
          if (attempts === 1) {
            throw new FilesystemHostSupervisorError('capacity', 'retiring children')
          }
        } else {
          await gate
        }
        return { kind: 'classify-path', deviceId: 'disk' }
      },
      publishFailureDomain,
      removeFailureDomain: vi.fn(),
      dispose: async () => {}
    }
  })
  try {
    authority.reconcileFailureDomains(['/slow/a', '/slow/b', '/slow/c', '/slow/d', '/healthy'])
    await vi.advanceTimersByTimeAsync(0)
    await expect(authority.readOrcaYaml('/healthy/orca.yaml')).resolves.toBe('scripts: {}')
    expect(attempts).toBe(1)
    release()
    await vi.advanceTimersByTimeAsync(25)
    expect(attempts).toBe(2)
    expect(publishFailureDomain).toHaveBeenCalledWith({
      executionHost: 'native',
      prefix: '/healthy',
      mountId: 'disk'
    })
  } finally {
    release()
    await authority.dispose()
    vi.useRealTimers()
  }
})
