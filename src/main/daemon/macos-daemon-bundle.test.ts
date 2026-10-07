import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/process-spec'

const { runProcessMock, inspectMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  inspectMock: vi.fn()
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('./daemon-mac-code-identity', () => ({ inspectMacProcessCodeIdentity: inspectMock }))

import { materializeMacDaemonBundle } from './macos-daemon-bundle'

const originalExecPath = process.execPath
const LABEL = 'com.stablyai.orca.terminal.owned'
const requirement = 'designated => identifier "com.stablyai.orca" and anchor apple generic'
let root: string
let source: string
let userData: string
let entry: string
let copyFailedOnce = false
let verificationFails = false
let requirementChanges = false

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-mac-runtime-')))
  source = join(root, 'com.stablyai.orca.ShipIt.old', 'Orca.app')
  userData = join(root, 'profile')
  process.execPath = join(root, 'installed', 'Orca.app', 'Contents', 'MacOS', 'Orca')
  entry = join(root, 'installed', 'Orca.app', 'Contents', 'Resources', 'daemon-entry.js')
  await mkdir(join(source, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(join(source, 'Contents', 'Resources'))
  await writeFile(join(source, 'Contents', 'MacOS', 'Orca'), 'signed-executable')
  await writeFile(join(source, 'Contents', 'Resources', 'daemon-entry.js'), 'daemon-code')
  copyFailedOnce = verificationFails = requirementChanges = false
  inspectMock.mockReset()
  inspectMock.mockResolvedValue({
    identity: 'parked',
    executablePath: join(source, 'Contents', 'MacOS', 'Orca')
  })
  runProcessMock.mockReset()
  runProcessMock.mockImplementation(async (spec) => {
    const args = spec.args ?? []
    let code = 0
    let stderr = ''
    if (spec.program === '/bin/cp') {
      const destination = args[2]
      if (!destination) {
        throw new Error('No copy destination')
      }
      if (copyFailedOnce && args[0] === '-cR') {
        await mkdir(destination)
        await writeFile(join(destination, 'partial'), 'partial-copy')
        code = 1
      } else {
        await cp(source, destination, { recursive: true })
      }
    } else if (args.includes('--verify')) {
      code = verificationFails ? 1 : 0
    } else {
      stderr =
        requirementChanges && args.at(-1) !== source ? 'designated => different' : requirement
    }
    return { code, signal: null, stdout: '', stderr, timedOut: false }
  })
})

afterEach(async () => {
  process.execPath = originalExecPath
  await rm(root, { recursive: true, force: true })
})

it('copies the running parked bundle rather than the replacement at the recorded path', async () => {
  const runtime = await materializeMacDaemonBundle(
    userData,
    entry,
    LABEL,
    new AbortController().signal
  )
  await rm(source, { recursive: true })
  expect(await readFile(runtime.execPath, 'utf8')).toBe('signed-executable')
  expect(await readFile(runtime.entryPath, 'utf8')).toBe('daemon-code')
  // Spotlight never indexes the copy, so it is not offered as a second Orca app.
  expect(runtime.bundlePath).toBe(join(runtime.directory, 'app.noindex', 'Orca.app'))
  expect(runProcessMock.mock.calls[1]?.[0].args).toEqual(['-cR', source, runtime.bundlePath])
  expect(JSON.parse(await readFile(join(runtime.directory, 'job.json'), 'utf8'))).toEqual({
    label: LABEL,
    producerPid: process.pid,
    submitted: false
  })
})

it('stops copying at the shared deadline and removes the partial runtime', async () => {
  const controller = new AbortController()
  const signed = runProcessMock.getMockImplementation()
  if (!signed) {
    throw new Error('No signing mock')
  }
  runProcessMock.mockImplementation(async (spec) => {
    expect(spec.signal).toBe(controller.signal)
    if (spec.program === '/bin/cp') {
      controller.abort()
    }
    if (controller.signal.aborted) {
      return { code: null, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    return signed(spec)
  })
  await expect(
    materializeMacDaemonBundle(userData, entry, LABEL, controller.signal)
  ).rejects.toThrow('Could not copy the macOS terminal runtime')
  expect(await readdir(join(userData, 'daemon-host', 'macos'))).toEqual([])
})

it('removes a partial clone before falling back to a regular copy', async () => {
  copyFailedOnce = true
  const runtime = await materializeMacDaemonBundle(
    userData,
    entry,
    LABEL,
    new AbortController().signal
  )
  expect(await readdir(runtime.bundlePath)).toEqual(['Contents'])
  expect(await readFile(runtime.entryPath, 'utf8')).toBe('daemon-code')
})

it('copies the app behind a symbolic link rather than retaining a link to the updater path', async () => {
  const alias = join(root, 'Linked.app')
  await symlink(source, alias, 'junction')
  inspectMock.mockResolvedValue({
    identity: 'resolved',
    executablePath: join(alias, 'Contents', 'MacOS', 'Orca')
  })
  const runtime = await materializeMacDaemonBundle(
    userData,
    entry,
    LABEL,
    new AbortController().signal
  )
  await rm(alias)
  await rm(source, { recursive: true })
  expect(await readFile(runtime.execPath, 'utf8')).toBe('signed-executable')
  expect(runProcessMock.mock.calls[1]?.[0].args).toEqual(['-cR', source, runtime.bundlePath])
})

it.each(['verification', 'requirement'])(
  'rejects and removes a copy with failed %s',
  async (failure) => {
    verificationFails = failure === 'verification'
    requirementChanges = failure === 'requirement'
    await expect(
      materializeMacDaemonBundle(userData, entry, LABEL, new AbortController().signal)
    ).rejects.toThrow('preserve the app signature')
    expect(await readdir(join(userData, 'daemon-host', 'macos'))).toEqual([])
  }
)

it('rejects an unresolvable running image before copying another installed build', async () => {
  inspectMock.mockResolvedValue({ identity: 'unresolvable', executablePath: null })
  await expect(
    materializeMacDaemonBundle(userData, entry, LABEL, new AbortController().signal)
  ).rejects.toThrow('running macOS app bundle')
  expect(runProcessMock).not.toHaveBeenCalled()
})

it('rejects an entry outside the signed app bundle', async () => {
  await expect(
    materializeMacDaemonBundle(
      userData,
      join(root, 'daemon-entry.js'),
      LABEL,
      new AbortController().signal
    )
  ).rejects.toThrow('outside the app bundle')
  expect(runProcessMock).not.toHaveBeenCalled()
})
