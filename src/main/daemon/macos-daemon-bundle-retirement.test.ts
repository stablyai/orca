import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/process-spec'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'

const { run, liveness } = vi.hoisted(() => ({
  run: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  liveness: vi.fn<() => ProcessLivenessVerdict>()
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: run }))
vi.mock('./daemon-process-inspection', () => ({ inspectProcessLiveness: liveness }))
import {
  retireAbandonedMacDaemonBundles,
  retireUnusedMacDaemonBundle,
  writeMacDaemonJobRecord
} from './macos-daemon-bundle-retirement'

const result: ProcessResult = { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
let root: string
const nativePlatform = process.platform
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')
beforeEach(async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 })
  root = await mkdtemp(join(tmpdir(), 'orca-runtime-retire-'))
  run.mockReset().mockResolvedValue(result)
  liveness.mockReset().mockReturnValue({ status: 'exited' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (originalGetuid) {
    Object.defineProperty(process, 'getuid', originalGetuid)
  } else {
    Reflect.deleteProperty(process, 'getuid')
  }
  await rm(root, { recursive: true, force: true })
})

async function runtime(submitted = true): Promise<string> {
  const directory = await mkdtemp(join(root, 'runtime-'))
  await mkdir(join(directory, 'Orca.app'))
  await writeMacDaemonJobRecord(directory, 'com.stablyai.orca.terminal.owned', false)
  if (submitted) {
    await writeMacDaemonJobRecord(directory, 'com.stablyai.orca.terminal.owned', true)
  }
  return directory
}

it('writes private non-secret metadata and prunes only a stopped, unused runtime', async () => {
  const directory = await runtime()
  if (nativePlatform !== 'win32') {
    expect((await stat(join(directory, 'job.json'))).mode & 0o777).toBe(0o600)
  }
  expect(JSON.parse(await readFile(join(directory, 'job.json'), 'utf8'))).toEqual({
    label: 'com.stablyai.orca.terminal.owned',
    producerPid: process.pid,
    submitted: true
  })
  run.mockImplementation(async (spec) =>
    spec.args?.[0] === 'print'
      ? { ...result, code: 0, stdout: '\tstate = not running' }
      : spec.args?.[0] === 'bootout'
        ? { ...result, code: 0 }
        : result
  )
  liveness.mockReturnValue({ status: 'live' })
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(directory)).rejects.toThrow()
  expect(run.mock.calls.map(([spec]) => spec.program)).toEqual([
    '/bin/launchctl',
    '/bin/launchctl',
    '/usr/sbin/lsof',
    LSREGISTER
  ])
  // The whole runtime directory is the open-file scope, so no bundle name needs recording.
  expect(run.mock.calls.at(-2)?.[0].args).toEqual(['-F', 'p', '+D', directory])
})

function launchServicesCalls(): (readonly string[])[] {
  return run.mock.calls
    .filter(([spec]) => spec.program === LSREGISTER)
    .map(([spec]) => spec.args ?? [])
}

it.each([
  { layout: 'current', bundle: ['app.noindex', 'Orca.app'] },
  { layout: 'pre-noindex', bundle: ['Orca.app'] }
])(
  'unregisters a retired $layout copy from LaunchServices before deleting it',
  async ({ bundle }) => {
    const directory = await mkdtemp(join(root, 'runtime-'))
    await mkdir(join(directory, ...bundle), { recursive: true })
    await writeMacDaemonJobRecord(directory, 'com.stablyai.orca.terminal.owned', true)
    let existedAtUnregister = false
    run.mockImplementation(async (spec) => {
      if (spec.program === LSREGISTER) {
        existedAtUnregister = await access(join(directory, ...bundle)).then(
          () => true,
          () => false
        )
        return { ...result, code: 0 }
      }
      return spec.args?.[0] === 'print'
        ? { ...result, code: 113, stderr: 'Could not find service "owned"' }
        : result
    })
    await retireAbandonedMacDaemonBundles(root)
    await expect(access(directory)).rejects.toThrow()
    expect(launchServicesCalls()).toEqual([['-u', join(directory, ...bundle)]])
    expect(existedAtUnregister).toBe(true)
  }
)

it('deletes a retired copy even when LaunchServices cannot unregister it', async () => {
  const directory = await runtime()
  run.mockImplementation(async (spec) => {
    if (spec.program === LSREGISTER) {
      throw new Error('lsregister unavailable')
    }
    return result
  })
  await retireUnusedMacDaemonBundle(directory)
  await expect(access(directory)).rejects.toThrow()
})

it('never unregisters a copy that is still in use', async () => {
  const directory = await runtime()
  run.mockResolvedValue({ ...result, code: 0, stdout: 'p123' })
  await retireUnusedMacDaemonBundle(directory)
  await expect(access(directory)).resolves.toBeUndefined()
  expect(launchServicesCalls()).toEqual([])
})

it('keeps a stopped runtime when its job could not be unregistered', async () => {
  const directory = await runtime()
  run.mockImplementation(async (spec) =>
    spec.args?.[0] === 'print'
      ? { ...result, code: 0, stdout: '\tstate = not running' }
      : { ...result, code: 1 }
  )
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(directory)).resolves.toBeUndefined()
  expect(run.mock.calls.some(([spec]) => spec.program === '/usr/sbin/lsof')).toBe(false)
})

it.each([{ status: 'live' }, { status: 'unverifiable', reason: 'denied' }] as const)(
  'retains a $status producer without querying launchd',
  async (verdict) => {
    const directory = await runtime(false)
    liveness.mockReturnValue(verdict)
    await retireAbandonedMacDaemonBundles(root)
    await expect(access(directory)).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  }
)

it('retires a never-submitted copy once its producer exited and its job is absent', async () => {
  const directory = await runtime(false)
  run.mockImplementation(async (spec) =>
    spec.args?.[0] === 'print'
      ? { ...result, code: 113, stderr: 'Could not find service "owned"' }
      : result
  )
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(directory)).rejects.toThrow()
  expect(run.mock.calls.map(([spec]) => spec.program)).toEqual([
    '/bin/launchctl',
    '/usr/sbin/lsof',
    LSREGISTER
  ])
})

it('retires a copy whose producer crashed before writing anything but its record', async () => {
  const directory = await mkdtemp(join(root, 'runtime-'))
  await writeMacDaemonJobRecord(directory, 'com.stablyai.orca.terminal.owned', false)
  run.mockImplementation(async (spec) =>
    spec.args?.[0] === 'print'
      ? { ...result, code: 113, stderr: 'Could not find service "owned"' }
      : result
  )
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(directory)).rejects.toThrow()
})

it('keeps a never-submitted copy that a running job or open file still uses', async () => {
  const runningCopy = await runtime(false)
  run.mockResolvedValue({ ...result, code: 0, stdout: '\tstate = running' })
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(runningCopy)).resolves.toBeUndefined()
  run.mockImplementation(async (spec) =>
    spec.args?.[0] === 'print'
      ? { ...result, code: 113, stderr: 'Could not find service "owned"' }
      : { ...result, code: 0, stdout: 'p123' }
  )
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(runningCopy)).resolves.toBeUndefined()
})

it('prunes an absent submitted job and coalesces overlapping collections', async () => {
  const directory = await runtime()
  run.mockImplementation(async (spec) =>
    spec.args?.[0] === 'print'
      ? { ...result, code: 113, stderr: 'Could not find service "owned"' }
      : result
  )
  const first = retireAbandonedMacDaemonBundles(root)
  expect(retireAbandonedMacDaemonBundles(root)).toBe(first)
  await first
  await expect(access(directory)).rejects.toThrow()
})

it.each([
  { code: 0, stdout: 'p123' },
  { stderr: 'permission denied' },
  { timedOut: true },
  { outputTruncated: true },
  { code: null }
])('retains code when open-file absence is unverified: %j', async (override) => {
  const directory = await runtime()
  run.mockResolvedValue({ ...result, ...override })
  await retireUnusedMacDaemonBundle(directory)
  await expect(access(directory)).resolves.toBeUndefined()
})

it('keeps scanning past copies it cannot retire', async () => {
  const first = await runtime()
  const second = await runtime()
  run.mockImplementation(async (spec) => {
    if (spec.args?.[0] === 'print') {
      return { ...result, code: 0, stdout: '\tstate = not running' }
    }
    // Every bootout fails, so stopMacDaemonJob's follow-up print must not report the job missing.
    return spec.args?.[0] === 'bootout' ? { ...result, code: 1 } : result
  })
  await retireAbandonedMacDaemonBundles(root)
  await expect(access(first)).resolves.toBeUndefined()
  await expect(access(second)).resolves.toBeUndefined()
  expect(run.mock.calls.filter(([spec]) => spec.args?.[0] === 'bootout')).toHaveLength(2)
})
