import { beforeEach, describe, expect, it, vi } from 'vitest'

const requests = vi.hoisted((): { url: string; method: string }[] => [])
const manifest = vi.hoisted((): { body: unknown } => ({ body: {} }))

vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method ?? 'GET' })
      return init?.method === 'HEAD'
        ? new Response(null, { headers: { 'content-length': '94371840' } })
        : Response.json(manifest.body)
    }
  })
}))

const SHA512 = 'ab'.repeat(64)
const BUILD = `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/${
  process.platform === 'win32'
    ? 'windows-x64/cli_windows_amd64.exe'
    : 'darwin-arm/cli_mac_arm64.tar.gz'
}`

async function freshRuntime() {
  vi.resetModules()
  return (await import('./agy-managed-runtime')).AGY_MANAGED_CLI.runtime
}

beforeEach(() => {
  requests.length = 0
})

describe('agy manifest platform', () => {
  it.each([
    ['darwin', 'arm64', false, 'darwin_arm64'],
    ['linux', 'x64', false, 'linux_amd64'],
    ['linux', 'arm64', true, 'linux_arm64_musl'],
    ['win32', 'x64', false, 'windows_amd64'],
    ['win32', 'ia32', false, null],
    ['freebsd', 'x64', false, null]
  ] as const)('%s %s (musl %s) reads %s', async (platform, arch, musl, expected) => {
    const { agyManifestPlatform } = await import('./agy-managed-runtime')
    expect(agyManifestPlatform(platform, arch, musl)).toBe(expected)
  })
})

describe('agy release pin', () => {
  it('pins the manifest build, checked by its sha512', async () => {
    manifest.body = { version: '1.5.13', url: BUILD, sha512: SHA512.toUpperCase() }
    const runtime = await freshRuntime()
    await runtime.refreshPin?.()

    expect(runtime.pin()).toEqual({
      version: '1.5.13',
      url: BUILD,
      archiveSha512: SHA512,
      archiveBytes: 94371840,
      ...(process.platform === 'win32'
        ? { format: 'file', executables: ['agy.exe'] }
        : { format: 'tar.gz', executables: ['agy'] })
    })
    expect(requests[0]?.url).toMatch(
      /^https:\/\/antigravity-cli-auto-updater-974169037036\.us-central1\.run\.app\/manifests\/[a-z]+_(amd64|arm64)(_musl)?\.json$/
    )
  })

  it.each([
    'https://storage.googleapis.com/other-bucket/cli_mac_arm64.tar.gz',
    'https://storage.googleapis.com/antigravity-public/antigravity-cli/../../other-bucket/x.tar.gz',
    'http://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13/cli_mac_arm64.tar.gz'
  ])('refuses a build outside Google’s release folder: %s', async (url) => {
    manifest.body = { version: '1.5.13', url, sha512: SHA512 }
    const runtime = await freshRuntime()

    await expect(runtime.refreshPin?.()).rejects.toThrow()
    expect(runtime.pin()).toBeNull()
    expect(requests.some((request) => request.method === 'HEAD')).toBe(false)
  })

  it('refuses a build published in a form it does not unpack', async () => {
    manifest.body = {
      version: '1.5.13',
      url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13/cli.zip',
      sha512: SHA512
    }
    const runtime = await freshRuntime()

    await expect(runtime.refreshPin?.()).rejects.toThrow("in a form Orca can't install")
    expect(runtime.pin()).toBeNull()
  })
})
