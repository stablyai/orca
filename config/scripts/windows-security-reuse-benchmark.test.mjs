import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'
import { sha256Of } from './orcad-prebuild-slot-contents.mjs'
import { peImage } from './windows-pe-image-fixture.mjs'
import {
  benchmarkWindowsSecurityReuse,
  probeSecurityArtifact,
  runSecurityComparisonSample,
  withInvalidSecurityCandidate
} from './benchmark-windows-security-reuse.mjs'

const directories = []
const sourceSha = 'a'.repeat(40)
const sidFixture = 'S-1-5-21-123456-234567-345678-1001'
const success = {
  code: 0,
  signal: null,
  timedOut: false,
  outputTruncated: false,
  stdout: '',
  stderr: ''
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
function fixture(arch = 'x64') {
  const root = mkdtempSync(join(tmpdir(), 'orca-security-qualification-'))
  directories.push(root)
  const candidate = join(root, 'native/windows-security/build/Release/orca_windows_security.node')
  mkdirSync(dirname(candidate), { recursive: true })
  writeFileSync(candidate, peImage({ arch }))
  mkdirSync(join(root, 'native/windows-security/src'))
  writeFileSync(join(root, 'native/windows-security/binding.gyp'), '{}')
  const runtimePath = join(root, 'pinned node.exe')
  writeFileSync(runtimePath, 'pinned fixture')
  const output = join(root, 'staged.node')
  const receiptFile = join(root, 'sample.json')
  const run = vi.fn((spec) => {
    if (spec.args.includes('rebuild')) {
      const built = join(spec.cwd, 'build/Release/orca_windows_security.node')
      mkdirSync(dirname(built), { recursive: true })
      writeFileSync(built, peImage({ arch }))
    }
    let stdout = ''
    if (spec.args[0] === '-e') {
      runInNewContext(spec.args[1], {
        process: {
          platform: 'win32',
          arch,
          versions: {},
          stdout: {
            write: (value) => {
              stdout += value
            }
          },
          exit: () => {
            throw new Error('invalid probe')
          }
        },
        require: (path) => {
          expect(existsSync(path)).toBe(true)
          return { currentUserSid: () => sidFixture }
        }
      })
    }
    return { ...success, stdout }
  })
  const runtimeAssets = { [`win32-${arch}`]: { executableSha256: digest('pinned fixture') } }
  return { root, arch, candidate, runtimePath, output, receiptFile, run, runtimeAssets }
}
function windows(arch = 'x64') {
  vi.stubGlobal('process', {
    ...process,
    platform: 'win32',
    arch,
    versions: { ...process.versions, node: NODE_RUNTIME_PIN.version }
  })
  vi.stubEnv('SOURCE_SHA', sourceSha)
  vi.stubEnv('BENCHMARK_RUNNER', arch === 'x64' ? 'windows-2022' : 'windows-11-arm')
}

it.each(['timeout', 'truncated', 'download', 'spawn'])(
  'cannot hide a %s in the reuse probe behind successful fallback',
  (failure) => {
    const f = fixture()
    windows()
    const original = f.run.getMockImplementation()
    f.run.mockImplementationOnce((spec) => {
      if (failure === 'spawn') {
        throw new Error(sidFixture)
      }
      if (failure === 'download') {
        return { ...success, stderr: 'gyp http GET https://nodejs.org/headers' }
      }
      return {
        ...original(spec),
        timedOut: failure === 'timeout',
        outputTruncated: failure === 'truncated'
      }
    })
    expect(() => runSecurityComparisonSample({ ...f, variant: 'candidate' })).toThrow()
    const receipt = JSON.parse(readFileSync(f.receiptFile, 'utf8'))
    expect(receipt.qualification).not.toBe('passed')
    expect(receipt.calls.some((call) => !call.complete)).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain(sidFixture)
  }
)

it('rejects wrong PE/runtime identity and a changed artifact during probing', () => {
  const f = fixture()
  expect(() => probeSecurityArtifact(f.candidate, f.runtimePath, 'x64', f.run)).toThrow(
    'Runtime hash'
  )
  expect(f.run).not.toHaveBeenCalled()
  expect(() =>
    probeSecurityArtifact(f.candidate, f.runtimePath, 'arm64', f.run, f.runtimeAssets)
  ).toThrow('architecture')
  writeFileSync(f.runtimePath, 'wrong runtime')
  expect(() =>
    probeSecurityArtifact(f.candidate, f.runtimePath, 'x64', f.run, f.runtimeAssets)
  ).toThrow('Runtime hash')
  expect(f.run).not.toHaveBeenCalled()
  writeFileSync(f.runtimePath, 'pinned fixture')
  f.run.mockImplementationOnce(() => {
    writeFileSync(f.candidate, 'changed')
    return { ...success, stdout: 'windows-security-ready' }
  })
  expect(() =>
    probeSecurityArtifact(f.candidate, f.runtimePath, 'x64', f.run, f.runtimeAssets)
  ).toThrow('changed during probe')
})

it.each(['success', 'rejection'])(
  'restores exact candidate bytes and permissions after %s',
  async (outcome) => {
    const f = fixture()
    const original = readFileSync(f.candidate)
    const before = statSync(f.candidate)
    const action = async () => {
      expect(readFileSync(f.candidate)).not.toEqual(original)
      if (outcome === 'rejection') {
        throw new Error('failed sample')
      }
      return 'proof'
    }
    const operation = withInvalidSecurityCandidate(f.candidate, f.root, digest(original), action)
    if (outcome === 'rejection') {
      await expect(operation).rejects.toThrow('failed sample')
    } else {
      expect(await operation).toBe('proof')
    }
    expect(readFileSync(f.candidate)).toEqual(original)
    expect(statSync(f.candidate).mode).toBe(before.mode)
    expect(statSync(f.candidate).mtimeMs).toBeCloseTo(before.mtimeMs, 0)
  }
)

it('refuses a changed candidate, symlink and preexisting backup before invalidating', async () => {
  const f = fixture()
  const bytes = readFileSync(f.candidate)
  const action = vi.fn()
  await expect(
    withInvalidSecurityCandidate(f.candidate, f.root, 'wrong hash', action)
  ).rejects.toThrow()
  writeFileSync(join(f.root, 'prepared-security-backup.node'), 'occupied')
  await expect(
    withInvalidSecurityCandidate(f.candidate, f.root, digest(bytes), action)
  ).rejects.toThrow()
  const link = join(f.root, 'link.node')
  symlinkSync(dirname(f.candidate), link, 'junction')
  await expect(withInvalidSecurityCandidate(link, f.root, digest(bytes), action)).rejects.toThrow(
    'regular file'
  )
  expect(readFileSync(f.candidate)).toEqual(bytes)
  expect(action).not.toHaveBeenCalled()
})

function hostedFixture(arch = 'x64', failure) {
  const f = fixture(arch)
  windows(arch)
  rmSync(f.candidate)
  for (const path of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    '.github/actions/prepare-native-runtime/action.yml',
    'src/shared/node-runtime-pin.ts',
    'config/scripts/build-windows-security-addon.mjs',
    'config/scripts/ensure-native-runtime.mjs',
    'config/scripts/benchmark-windows-security-reuse.mjs'
  ]) {
    mkdirSync(dirname(join(f.root, path)), { recursive: true })
    writeFileSync(join(f.root, path), 'source fixture')
  }
  const ensureRuntime = vi.fn(async () => f.runtimePath)
  const prepareHeaders = vi.fn(async ({ workDir }) => {
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, 'header'), 'verified header fixture')
    return workDir
  })
  const run = vi.fn(async (spec) => {
    if (spec.args.includes('HEAD') && spec.args.includes('rev-parse')) {
      return { ...success, stdout: sourceSha }
    }
    if (spec.args.includes('HEAD^{tree}')) {
      return { ...success, stdout: 'b'.repeat(40) }
    }
    if (spec.args.includes('native/windows-security')) {
      return { ...success, stdout: 'native/windows-security/binding.gyp\n' }
    }
    if (spec.args.some((arg) => arg.endsWith('initialize-windows-native-toolchain.mjs'))) {
      writeFileSync(f.candidate, peImage({ arch }))
    }
    const variant = spec.args.find((arg) => arg.startsWith('--sample='))?.slice(9)
    if (variant) {
      if (failure === variant) {
        return { ...success, code: 1, timedOut: true, stderr: sidFixture }
      }
      runSecurityComparisonSample({
        ...f,
        variant,
        output: spec.args[3],
        receiptFile: spec.args[4]
      })
    }
    return success
  })
  f.ports = {
    run,
    runSync: f.run,
    ensureRuntime,
    prepareHeaders,
    runtimeAssets: f.runtimeAssets,
    hashFile: (path) => (path === process.execPath ? digest('pinned fixture') : sha256Of(path))
  }
  return f
}

it('restores the owned candidate and leaves a failed redacted receipt when fallback times out', async () => {
  const f = hostedFixture('x64', 'fallback')
  await expect(benchmarkWindowsSecurityReuse(f.root, f.ports)).rejects.toThrow('did not qualify')
  const report = JSON.parse(
    readFileSync(join(f.root, '.build/windows-native-benchmark/security/receipt.json'), 'utf8')
  )
  expect(report.qualification).toBe('failed')
  expect(report.failureStage).toBe('fallback-full-build-and-probe')
  expect(report.restored).toBe(true)
  expect(sha256Of(f.candidate)).toBe(report.prepared.sha256)
  expect(
    report.phases.find((phase) => phase.label === 'fallback-full-build-and-probe').timedOut
  ).toBe(true)
  expect(JSON.stringify(report)).not.toContain(sidFixture)
})
