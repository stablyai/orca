import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import {
  buildWindowsSecurityAddon,
  reusePreparedWindowsSecurityAddon
} from './build-windows-security-addon.mjs'
import { peImage } from './windows-pe-image-fixture.mjs'

const roots = []
afterEach(() => {
  vi.unstubAllGlobals()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

const success = { code: 0, timedOut: false, outputTruncated: false, stdout: '' }
function fixture(arch = 'x64') {
  const root = mkdtempSync(join(tmpdir(), 'windows-security-build-'))
  roots.push(root)
  const candidate = join(root, 'native/windows-security/build/Release/orca_windows_security.node')
  mkdirSync(dirname(candidate), { recursive: true })
  writeFileSync(candidate, peImage({ arch }))
  mkdirSync(join(root, 'native/windows-security/src'))
  writeFileSync(join(root, 'native/windows-security/binding.gyp'), '{}')
  writeFileSync(join(root, 'native/windows-security/src/addon.cc'), 'source')
  const runtimePath = join(root, 'pinned node.exe')
  writeFileSync(runtimePath, 'pinned Node fixture')
  const executableSha256 = createHash('sha256').update('pinned Node fixture').digest('hex')
  const runtimeAssets = { [`win32-${arch}`]: { executableSha256 } }
  const output = join(root, 'output/windows-security.node')
  const run = vi.fn((invocation) => {
    if (invocation.args.includes('rebuild')) {
      const built = join(invocation.cwd, 'build/Release/orca_windows_security.node')
      mkdirSync(dirname(built), { recursive: true })
      writeFileSync(
        built,
        peImage({ arch: invocation.args.find((arg) => arg.startsWith('--arch=')).slice(7) })
      )
      return success
    }
    return {
      ...success,
      stdout: invocation.program === runtimePath ? 'windows-security-ready' : ''
    }
  })
  return {
    candidate,
    output,
    options: {
      enabled: true,
      root,
      runtimePath,
      platform: 'win32',
      hostArch: arch,
      runtimeAssets,
      run
    }
  }
}

it.each(['x64', 'arm64'])('reuses the exact prepared %s candidate under pinned Node', (arch) => {
  const { candidate, output, options } = fixture(arch)
  expect(reusePreparedWindowsSecurityAddon(arch, output, options)).toBe(true)
  expect(readFileSync(output)).toEqual(readFileSync(candidate))
  const [preparation, probe] = options.run.mock.calls.map(([invocation]) => invocation)
  expect(preparation).toEqual({
    program: process.execPath,
    args: [
      join(options.root, 'config/scripts/ensure-native-runtime.mjs'),
      '--runtime=node',
      '--check-only'
    ],
    cwd: options.root,
    timeoutMs: 30_000
  })
  expect(probe.program).toBe(options.runtimePath)
  expect(isAbsolute(probe.program)).toBe(true)
  expect(probe.timeoutMs).toBe(30_000)
  const requireAddon = vi.fn(() => ({ currentUserSid: () => 'S-1-5-21-123-456-789-1001' }))
  const write = vi.fn()
  runInNewContext(probe.args[1], {
    process: { platform: 'win32', arch, versions: {}, stdout: { write } },
    require: requireAddon
  })
  expect(requireAddon).toHaveBeenCalledWith(candidate)
  expect(isAbsolute(candidate)).toBe(true)
  expect(write).toHaveBeenCalledWith('windows-security-ready')
})

it.each([
  { enabled: false },
  { enabled: undefined },
  { platform: 'darwin' },
  { platform: 'linux' },
  { hostArch: 'arm64' },
  { runtimePath: undefined },
  { runtimePath: 'node.exe' }
])('declines reuse without same-host opt-in and pinned runtime: %j', (overrides) => {
  const { output, options } = fixture()
  expect(reusePreparedWindowsSecurityAddon('x64', output, { ...options, ...overrides })).toBe(false)
  expect(options.run).not.toHaveBeenCalled()
})

it('declines missing, corrupt, wrong-architecture candidates and an unverified runtime', () => {
  const { candidate, output, options } = fixture()
  expect(
    reusePreparedWindowsSecurityAddon('x64', output, {
      ...options,
      runtimeAssets: undefined
    })
  ).toBe(false)
  expect(options.run).not.toHaveBeenCalled()
  for (const bytes of [Buffer.from('corrupt'), peImage({ arch: 'arm64' })]) {
    writeFileSync(candidate, bytes)
    expect(reusePreparedWindowsSecurityAddon('x64', output, options)).toBe(false)
  }
  rmSync(candidate)
  expect(reusePreparedWindowsSecurityAddon('x64', output, options)).toBe(false)
  writeFileSync(candidate, peImage())
  writeFileSync(options.runtimePath, 'different Node')
  expect(reusePreparedWindowsSecurityAddon('x64', output, options)).toBe(false)
  expect(options.run).not.toHaveBeenCalled()
})

it.each([
  { code: 1 },
  { code: null },
  { timedOut: true },
  { outputTruncated: true },
  { stdout: '' },
  { stdout: 'S-1-5-21-123' },
  { stdout: 'windows-security-ready\nextra output' }
])('declines failed loading or invalid probe results: %j', (result) => {
  const { output, options } = fixture()
  options.run
    .mockReturnValueOnce(success)
    .mockReturnValueOnce({ ...success, stdout: 'windows-security-ready', ...result })
  expect(reusePreparedWindowsSecurityAddon('x64', output, options)).toBe(false)
})

it.each([{ code: 1 }, { timedOut: true }, { outputTruncated: true }])(
  'does not load the candidate after failed Node preparation: %j',
  (result) => {
    const { output, options } = fixture()
    options.run.mockReturnValueOnce({ ...success, ...result })
    expect(reusePreparedWindowsSecurityAddon('x64', output, options)).toBe(false)
    expect(options.run).toHaveBeenCalledOnce()
  }
)

it('declines probe spawn exceptions', () => {
  const { output, options } = fixture()
  options.run.mockImplementation(() => {
    throw new Error('spawn failed')
  })
  expect(reusePreparedWindowsSecurityAddon('x64', output, options)).toBe(false)
})

it.each(['', undefined, 123, 'invalid', 'S-1-no-sid'])(
  'the probe rejects invalid currentUserSid results: %j',
  (sid) => {
    const { output, options } = fixture()
    reusePreparedWindowsSecurityAddon('x64', output, options)
    const probe = options.run.mock.calls[1][0]
    const write = vi.fn()
    expect(() =>
      runInNewContext(probe.args[1], {
        process: {
          platform: 'win32',
          arch: 'x64',
          versions: {},
          stdout: { write },
          exit: (code) => {
            throw new Error(`exit ${code}`)
          }
        },
        require: () => ({ currentUserSid: () => sid })
      })
    ).toThrow('exit 2')
    expect(write).not.toHaveBeenCalled()
  }
)

it.each([
  'non-opt-in',
  'cold',
  'corrupt',
  'wrong architecture',
  'cross compilation',
  'load failure',
  'valid'
])('the builder retains real compilation unless reuse succeeds: %s', (scenario) => {
  const { candidate, output, options } = fixture()
  vi.stubGlobal('process', { ...process, platform: 'win32', arch: 'x64' })
  if (scenario === 'non-opt-in') {
    options.enabled = false
  }
  if (scenario === 'cold') {
    rmSync(candidate)
  }
  if (scenario === 'corrupt') {
    writeFileSync(candidate, 'bad')
  }
  if (scenario === 'wrong architecture') {
    writeFileSync(candidate, peImage({ arch: 'arm64' }))
  }
  if (scenario === 'load failure') {
    options.run.mockReturnValueOnce(success).mockReturnValueOnce({ ...success, code: 1 })
  }
  const arch = scenario === 'cross compilation' ? 'arm64' : 'x64'
  expect(buildWindowsSecurityAddon(arch, output, options)).toBe(output)
  expect(
    options.run.mock.calls.filter(([invocation]) => invocation.args.includes('rebuild'))
  ).toHaveLength(scenario === 'valid' ? 0 : 1)
})

it('standalone compilation rejects unsupported architectures and non-Windows hosts', () => {
  const { output, options } = fixture()
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  expect(() => buildWindowsSecurityAddon('ia32', output, options)).toThrow('--arch must be')
  expect(() => buildWindowsSecurityAddon('x64', output, options)).toThrow('only builds on Windows')
  expect(options.run).not.toHaveBeenCalled()
})

it.each(['failed compiler', 'missing output', 'wrong machine'])(
  'the cold path fails closed on %s',
  (failure) => {
    const { output, options } = fixture()
    vi.stubGlobal('process', { ...process, platform: 'win32', arch: 'x64' })
    options.enabled = false
    options.run.mockImplementation((invocation) => {
      if (failure === 'wrong machine') {
        const built = join(invocation.cwd, 'build/Release/orca_windows_security.node')
        mkdirSync(dirname(built), { recursive: true })
        writeFileSync(built, peImage({ arch: 'arm64' }))
      }
      return { ...success, code: failure === 'failed compiler' ? 1 : 0 }
    })
    expect(() => buildWindowsSecurityAddon('x64', output, options)).toThrow()
    expect(() => readFileSync(output)).toThrow()
  }
)
