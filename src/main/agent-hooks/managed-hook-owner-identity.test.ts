import { afterEach, describe, expect, it, vi } from 'vitest'

const originalPlatform = process.platform
const originalGetuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid')

type LinuxIdentityFixture = {
  hostToken?: string
  bootId?: string
  pidNamespace?: string
  statErrorCode?: string
}

async function loadLinuxIdentity(fixture: LinuxIdentityFixture) {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1000 })
  const statFields = ['S', ...Array.from({ length: 18 }, () => '0'), '4242']
  const readFile = vi.fn(async (path: string | URL) => {
    if (String(path).endsWith('host-id') && fixture.hostToken) {
      return fixture.hostToken
    }
    switch (String(path)) {
      case '/proc/sys/kernel/random/boot_id':
        if (fixture.bootId) {
          return `${fixture.bootId}\n`
        }
        break
      case `/proc/${process.pid}/stat`:
      case '/proc/123/stat':
        if (!fixture.statErrorCode) {
          return `123 (node relay) ${statFields.join(' ')}`
        }
        break
      default:
        throw new Error(`unexpected path: ${String(path)}`)
    }
    throw Object.assign(new Error(`unavailable path: ${String(path)}`), {
      code: fixture.statErrorCode ?? 'ENOENT'
    })
  })
  const readlink = vi.fn(async (path: string | URL) => {
    if (fixture.pidNamespace) {
      return fixture.pidNamespace
    }
    throw Object.assign(new Error(`unavailable path: ${String(path)}`), { code: 'EACCES' })
  })
  const mkdir = vi.fn(async () => {
    if (!fixture.hostToken) {
      throw Object.assign(new Error('host-local storage unavailable'), { code: 'EACCES' })
    }
  })
  const lstat = vi.fn(async (path: string | URL) => {
    const isToken = String(path).endsWith('host-id')
    return {
      isDirectory: () => !isToken,
      isFile: () => isToken,
      mode: isToken ? 0o100600 : 0o040700,
      uid: process.getuid?.() ?? 0
    }
  })
  vi.doMock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    lstat,
    mkdir,
    readFile,
    readlink
  }))
  return { identity: await import('./managed-hook-owner-identity'), readFile }
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  if (originalGetuidDescriptor) {
    Object.defineProperty(process, 'getuid', originalGetuidDescriptor)
  } else {
    Reflect.deleteProperty(process, 'getuid')
  }
  vi.unstubAllEnvs()
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
})

describe('managed hook owner identity', () => {
  it('uses durable host-local identity without requiring Linux machine identity files', async () => {
    vi.stubEnv('SSH_CONNECTION', '198.51.100.8 53100 10.0.0.7 2222')
    const { identity, readFile } = await loadLinuxIdentity({
      hostToken: '00000000-0000-4000-8000-000000000001',
      bootId: 'current-boot-id',
      pidNamespace: 'pid:[4026533001]'
    })

    await expect(identity.readManagedHookHostIdentity()).resolves.toBe(
      'host-token:00000000-0000-4000-8000-000000000001'
    )
    expect(readFile).not.toHaveBeenCalledWith('/etc/machine-id', 'utf8')
  })

  it('separates SSH backends that share a key, endpoint, and boot metadata', async () => {
    vi.stubEnv('SSH_CONNECTION', '198.51.100.8 53100 10.0.0.7 2222')
    const first = await loadLinuxIdentity({
      hostToken: '00000000-0000-4000-8000-000000000001',
      bootId: 'shared-kernel-boot-id',
      pidNamespace: 'pid:[4026533001]'
    })
    const firstHost = await first.identity.readManagedHookHostIdentity()
    const firstProcess = await first.identity.readManagedHookProcessIdentity(123)
    const fingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const firstScopedHost = first.identity.scopeManagedHookHostIdentity(firstHost, fingerprint)

    vi.doUnmock('node:fs/promises')
    vi.resetModules()
    const second = await loadLinuxIdentity({
      hostToken: '00000000-0000-4000-8000-000000000002',
      bootId: 'shared-kernel-boot-id',
      pidNamespace: 'pid:[4026533002]'
    })

    const secondHost = await second.identity.readManagedHookHostIdentity()
    expect(secondHost).not.toBe(firstHost)
    expect(second.identity.scopeManagedHookHostIdentity(secondHost, fingerprint)).not.toBe(
      firstScopedHost
    )
    await expect(second.identity.readManagedHookProcessIdentity(123)).resolves.not.toBe(
      firstProcess
    )
  })

  it('keeps one host scope stable across reboot while changing its process incarnation', async () => {
    const fixture = {
      hostToken: '00000000-0000-4000-8000-000000000001',
      bootId: 'first-boot-id',
      pidNamespace: 'pid:[4026533001]'
    }
    const first = await loadLinuxIdentity(fixture)
    const firstHost = await first.identity.readManagedHookHostIdentity()
    const firstProcess = await first.identity.readManagedHookProcessIdentity(123)

    vi.doUnmock('node:fs/promises')
    vi.resetModules()
    const second = await loadLinuxIdentity({
      ...fixture,
      bootId: 'second-boot-id',
      pidNamespace: 'pid:[4026534001]'
    })

    await expect(second.identity.readManagedHookHostIdentity()).resolves.toBe(firstHost)
    await expect(second.identity.readManagedHookProcessIdentity(123)).resolves.not.toBe(
      firstProcess
    )
  })

  it('falls back safely when machine, boot, and namespace probes are unavailable', async () => {
    vi.stubEnv('SSH_CONNECTION', '')
    const { identity } = await loadLinuxIdentity({ statErrorCode: 'EACCES' })

    const hostIdentity = await identity.readManagedHookHostIdentity()
    const processIdentity = await identity.readManagedHookProcessIdentity(process.pid)
    expect(hostIdentity).toMatch(/^runtime:/)
    expect(processIdentity).toMatch(/^runtime:/)
    await expect(identity.readManagedHookHostIdentity()).resolves.toBe(hostIdentity)
    await expect(identity.readManagedHookProcessIdentity(process.pid)).resolves.toBe(
      processIdentity
    )
    await expect(identity.readManagedHookProcessIdentity(123)).resolves.toBeUndefined()
  })

  it('includes namespace, boot, and start ticks when Linux exposes them', async () => {
    vi.stubEnv('SSH_CONNECTION', '')
    const { identity } = await loadLinuxIdentity({
      hostToken: '00000000-0000-4000-8000-000000000001',
      bootId: 'current-boot-id',
      pidNamespace: 'pid:[4026533001]'
    })

    await expect(identity.readManagedHookHostIdentity()).resolves.toBe(
      'host-token:00000000-0000-4000-8000-000000000001'
    )
    await expect(identity.readManagedHookProcessIdentity(123)).resolves.toBe(
      'linux:pid:[4026533001]:current-boot-id:4242'
    )
  })
})
