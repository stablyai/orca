import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const { run } = vi.hoisted(() => ({
  run: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
}))
vi.mock('@orca/process-host', () => ({ runProcess: run }))
import {
  retireOtherMacDaemonCopies,
  retireUnusedMacDaemonCopy
} from './macos-daemon-bundle-retirement'

// An unused lsof tree prints nothing and exits 1.
const unused: ProcessResult = { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
// Exit 1 alone is insufficient: live copies can still report user PIDs.
const inUse: ProcessResult = { ...unused, stdout: 'p123\nftxt\nftxt\n' }
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-runtime-retire-'))
  run.mockReset().mockResolvedValue(unused)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function copy(name: string): Promise<string> {
  const directory = join(root, name)
  await mkdir(join(directory, 'app.noindex', 'Orca Terminal Host.app'), { recursive: true })
  return directory
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

function lsofReports(byDirectory: Record<string, ProcessResult>): void {
  run.mockImplementation(async (spec) =>
    spec.program === '/usr/sbin/lsof' ? (byDirectory[spec.args?.at(-1) ?? ''] ?? unused) : unused
  )
}

it('keeps a copy whose lsof scan lists a process even though lsof exits 1', async () => {
  const directory = await copy('terminal-host-old')
  run.mockResolvedValue(inUse)
  await retireUnusedMacDaemonCopy(directory)
  expect(await exists(directory)).toBe(true)
  expect(run.mock.calls.some(([spec]) => spec.program === LSREGISTER)).toBe(false)
})

it.each([
  { stderr: 'lsof: WARNING: can not stat' },
  { timedOut: true },
  { outputTruncated: true },
  { code: null },
  { code: 0 }
])('keeps a copy when the scan is incomplete: %j', async (override) => {
  const directory = await copy('terminal-host-old')
  run.mockResolvedValue({ ...unused, ...override })
  await retireUnusedMacDaemonCopy(directory)
  expect(await exists(directory)).toBe(true)
})

it('unregisters an unused copy from LaunchServices, then deletes it', async () => {
  const directory = await copy('terminal-host-old')
  const bundle = join(directory, 'app.noindex', 'Orca Terminal Host.app')
  let bundleExistedAtUnregister = false
  run.mockImplementation(async (spec) => {
    if (spec.program === LSREGISTER) {
      expect(spec.args).toEqual(['-u', bundle])
      bundleExistedAtUnregister = await exists(bundle)
    }
    return unused
  })
  await retireUnusedMacDaemonCopy(directory)
  expect(bundleExistedAtUnregister).toBe(true)
  expect(await exists(directory)).toBe(false)
})

it('deletes an unused copy even when LaunchServices cannot unregister it', async () => {
  const directory = await copy('terminal-host-old')
  run.mockImplementation(async (spec) => {
    if (spec.program === LSREGISTER) {
      throw new Error('lsregister unavailable')
    }
    return unused
  })
  await retireUnusedMacDaemonCopy(directory)
  expect(await exists(directory)).toBe(false)
})

it("retires every unused copy and staging dir except the current build's and this process's staging", async () => {
  const current = await copy('terminal-host-current')
  const oldUnused = await copy('terminal-host-old')
  const oldInUse = await copy('terminal-host-older')
  const crashedStaging = await copy('terminal-host-current.staging-1-AbCdEf')
  const ownStaging = await copy(`terminal-host-current.staging-${process.pid}-AbCdEf`)
  lsofReports({ [oldInUse]: inUse })
  await retireOtherMacDaemonCopies(root, current)
  expect(await exists(current)).toBe(true)
  expect(await exists(ownStaging)).toBe(true)
  expect(await exists(oldInUse)).toBe(true)
  expect(await exists(oldUnused)).toBe(false)
  expect(await exists(crashedStaging)).toBe(false)
})

it('runs one collection at a time and tolerates a missing root', async () => {
  const first = retireOtherMacDaemonCopies(join(root, 'absent'), join(root, 'absent', 'x'))
  expect(retireOtherMacDaemonCopies(root, join(root, 'x'))).toBe(first)
  await expect(first).resolves.toBeUndefined()
})
