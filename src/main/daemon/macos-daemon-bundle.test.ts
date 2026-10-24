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
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const { runProcessMock, inspectMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  inspectMock: vi.fn()
}))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('./daemon-mac-code-identity', () => ({ inspectMacProcessCodeIdentity: inspectMock }))

import { materializeMacDaemonBundle } from './macos-daemon-bundle'

const APP_REQUIREMENT = 'identifier "com.stablyai.orca" and anchor apple generic'
const ok: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
let root: string
let source: string
let helper: string
let copies: string
let cdhash: string
let cloneLeavesPartialTree: boolean
let verifyCode: number
let onCopy: (() => Promise<void>) | null

const signal = (): AbortSignal => new AbortController().signal
const helperExecutable = (): string => join(helper, 'Contents', 'MacOS', 'orca-terminal-host')

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-mac-runtime-')))
  // Model an update that moved the running bundle and replaced its original path.
  source = join(root, 'com.stablyai.orca.ShipIt.old', 'Orca.app')
  helper = join(source, 'Contents', 'Helpers', 'Orca Terminal Host.app')
  copies = join(root, 'profile', 'daemon-host', 'macos')
  await mkdir(join(source, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(join(helper, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(join(helper, 'Contents', 'Resources', 'daemon', 'out', 'main'), { recursive: true })
  await writeFile(helperExecutable(), 'signed-node')
  await writeFile(
    join(helper, 'Contents', 'Resources', 'daemon', 'out', 'main', 'daemon-entry.js'),
    'daemon-code'
  )
  cdhash = 'a'.repeat(40)
  cloneLeavesPartialTree = false
  verifyCode = 0
  onCopy = null
  inspectMock.mockReset().mockResolvedValue({
    identity: 'parked',
    executablePath: join(source, 'Contents', 'MacOS', 'Orca')
  })
  runProcessMock.mockReset().mockImplementation(async (spec) => {
    const args = spec.args ?? []
    if (spec.program === '/bin/cp') {
      const [flag, from, destination] = args
      if (!from || !destination) {
        throw new Error('No copy source or destination')
      }
      if (cloneLeavesPartialTree && flag === '-cR') {
        await mkdir(destination)
        await writeFile(join(destination, 'partial'), 'partial-copy')
        return { ...ok, code: 1 }
      }
      await cp(from, destination, { recursive: true })
      await onCopy?.()
      return ok
    }
    if (args[0] === '-dvvv') {
      return args[1] === helper
        ? { ...ok, stderr: `Identifier=x\nCDHash=${cdhash}\n` }
        : { ...ok, code: 1 }
    }
    if (args[0] === '--display') {
      return args.at(-1) === source
        ? { ...ok, stderr: `designated => ${APP_REQUIREMENT}\n` }
        : { ...ok, code: 1 }
    }
    if (args[0] === '--verify') {
      return { ...ok, code: args.includes(`=${APP_REQUIREMENT}`) ? verifyCode : 3 }
    }
    throw new Error(`Unexpected ${spec.program} ${args.join(' ')}`)
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const runs = (flag: string): number =>
  runProcessMock.mock.calls.filter(([spec]) => spec.args?.[0] === flag).length

it('publishes one verified copy per helper build, from the running app rather than its replacement', async () => {
  const copy = await materializeMacDaemonBundle(copies, signal())
  await rm(source, { recursive: true })
  expect(copy.directory).toBe(join(copies, `terminal-host-${cdhash}`))
  expect(copy.execPath).toBe(
    join(
      copy.directory,
      'app.noindex',
      'Orca Terminal Host.app',
      'Contents',
      'MacOS',
      'orca-terminal-host'
    )
  )
  expect(await readFile(copy.execPath, 'utf8')).toBe('signed-node')
  expect(await readFile(copy.entryPath, 'utf8')).toBe('daemon-code')
  expect(await readdir(copies)).toEqual([`terminal-host-${cdhash}`])
})

it('reuses a published copy without copying or verifying again', async () => {
  const first = await materializeMacDaemonBundle(copies, signal())
  await writeFile(helperExecutable(), 'same-build-rewritten')
  const second = await materializeMacDaemonBundle(copies, signal())
  expect(second).toEqual(first)
  expect(await readFile(second.execPath, 'utf8')).toBe('signed-node')
  expect(runs('-cR')).toBe(1)
  expect(runs('--verify')).toBe(1)
})

it('publishes a new copy beside the old one when the helper build changes', async () => {
  const first = await materializeMacDaemonBundle(copies, signal())
  cdhash = 'b'.repeat(40)
  await writeFile(helperExecutable(), 'next-build')
  const second = await materializeMacDaemonBundle(copies, signal())
  expect(second.directory).not.toBe(first.directory)
  expect(await readFile(second.execPath, 'utf8')).toBe('next-build')
  expect(await readFile(first.execPath, 'utf8')).toBe('signed-node')
})

it("rejects a copy that does not satisfy the running app's requirement and publishes nothing", async () => {
  verifyCode = 3
  await expect(materializeMacDaemonBundle(copies, signal())).rejects.toThrow(
    "does not satisfy the app's signature"
  )
  expect(await readdir(copies)).toEqual([])
})

it('keeps the winning copy when a concurrent publisher renames first', async () => {
  onCopy = async () => {
    onCopy = null
    const winner = join(copies, `terminal-host-${cdhash}`, 'app.noindex', 'Orca Terminal Host.app')
    await cp(helper, winner, { recursive: true })
    await writeFile(join(winner, 'Contents', 'MacOS', 'orca-terminal-host'), 'winner')
  }
  const copy = await materializeMacDaemonBundle(copies, signal())
  expect(await readFile(copy.execPath, 'utf8')).toBe('winner')
  expect(await readdir(copies)).toEqual([`terminal-host-${cdhash}`])
})

it('replaces a partial clone with a regular copy', async () => {
  cloneLeavesPartialTree = true
  const copy = await materializeMacDaemonBundle(copies, signal())
  expect(await readdir(join(copy.directory, 'app.noindex', 'Orca Terminal Host.app'))).toEqual([
    'Contents'
  ])
  expect(await readFile(copy.entryPath, 'utf8')).toBe('daemon-code')
})

it('stops at the shared deadline and removes the staging copy', async () => {
  const controller = new AbortController()
  const signed = runProcessMock.getMockImplementation()
  runProcessMock.mockImplementation(async (spec) => {
    if (spec.program === '/bin/cp') {
      controller.abort()
    }
    return controller.signal.aborted ? { ...ok, code: null } : (signed?.(spec) ?? ok)
  })
  await expect(materializeMacDaemonBundle(copies, controller.signal)).rejects.toThrow(
    'Could not copy Orca Terminal Host.app'
  )
  expect(await readdir(copies)).toEqual([])
})

it('copies the app behind a symbolic link rather than retaining a link to the updater path', async () => {
  const alias = join(root, 'Linked.app')
  await symlink(source, alias, 'junction')
  inspectMock.mockResolvedValue({
    identity: 'resolved',
    executablePath: join(alias, 'Contents', 'MacOS', 'Orca')
  })
  const copy = await materializeMacDaemonBundle(copies, signal())
  await rm(alias)
  await rm(source, { recursive: true })
  expect(await readFile(copy.execPath, 'utf8')).toBe('signed-node')
})

it('rejects an unresolvable running image before running anything', async () => {
  inspectMock.mockResolvedValue({ identity: 'unresolvable', executablePath: null })
  await expect(materializeMacDaemonBundle(copies, signal())).rejects.toThrow(
    'running macOS app bundle'
  )
  expect(runProcessMock).not.toHaveBeenCalled()
})

it('rejects an app without a signed helper and makes no copy', async () => {
  await rm(helper, { recursive: true })
  helper = join(root, 'elsewhere')
  await expect(materializeMacDaemonBundle(copies, signal())).rejects.toThrow('CDHash')
  await expect(readdir(copies)).rejects.toThrow()
})
