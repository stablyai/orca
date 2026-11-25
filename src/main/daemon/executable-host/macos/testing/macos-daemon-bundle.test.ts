import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const { runProcessMock, inspectMock, appProfileMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  inspectMock: vi.fn(),
  appProfileMock: vi.fn((): unknown => null)
}))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('../daemon-mac-code-identity', () => ({ inspectMacProcessCodeIdentity: inspectMock }))
vi.mock('../../../../app-profiles/app-profile', () => ({ getAppProfile: appProfileMock }))

import { materializeMacDaemonBundle } from '../macos-daemon-bundle'

const ok: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
let root: string
let verifyPasses: boolean

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function materializeForProfile(): Promise<{ copies: string; cdhash: string }> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-mac-runtime-')))
  const defaultApp = join(root, 'Orca.app')
  const helper = join(defaultApp, 'Contents', 'Helpers', 'Orca Agents.app')
  await mkdir(join(helper, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(helper, 'Contents', 'MacOS', 'Orca Agents'), 'signed-node')
  // The profile app is ad hoc: its designated requirement is its own cdhash. Its app.asar link
  // points into the default app.
  const asar = join(defaultApp, 'Contents', 'Resources', 'app.asar')
  await mkdir(join(defaultApp, 'Contents', 'Resources'), { recursive: true })
  await writeFile(asar, 'asar')
  const profile = join(root, 'Profiles', 'Work.app')
  await mkdir(join(profile, 'Contents', 'Resources'), { recursive: true })
  await mkdir(join(profile, 'Contents', 'MacOS'), { recursive: true })
  await symlink(asar, join(profile, 'Contents', 'Resources', 'app.asar'))
  appProfileMock.mockReturnValue({ id: 'work' })
  inspectMock.mockResolvedValue({
    identity: 'profile',
    executablePath: join(profile, 'Contents', 'MacOS', 'Orca')
  })
  const cdhash = 'a'.repeat(40)
  const hostRequirement = `cdhash H"${cdhash}"`
  runProcessMock.mockImplementation(async (spec) => {
    const args = spec.args ?? []
    if (spec.program === '/bin/cp') {
      await cp(args[1]!, args[2]!, { recursive: true })
      return ok
    }
    if (args[0] === '-dvvv') {
      return args[1] === helper ? { ...ok, stderr: `CDHash=${cdhash}\n` } : { ...ok, code: 1 }
    }
    if (args[0] === '--display') {
      return args.at(-1) === helper
        ? { ...ok, stderr: `# designated => ${hostRequirement}\n` }
        : { ...ok, stderr: '# designated => cdhash H"0000"\n' }
    }
    if (args[0] === '--verify') {
      return { ...ok, code: verifyPasses && args.includes(`=${hostRequirement}`) ? 0 : 3 }
    }
    throw new Error(`Unexpected ${spec.program} ${args.join(' ')}`)
  })
  return { copies: join(root, 'profile', 'daemon-host', 'macos'), cdhash }
}

it("gives a profile app the default app's host, checked against the host's own signature", async () => {
  verifyPasses = true
  const { copies, cdhash } = await materializeForProfile()
  const copy = await materializeMacDaemonBundle(copies, new AbortController().signal)
  expect(await readFile(copy.execPath, 'utf8')).toBe('signed-node')
  expect(copy.directory).toBe(join(copies, `terminal-host-${cdhash}`))
})

it("refuses a host copy that does not match the host's own signature", async () => {
  verifyPasses = false
  const { copies } = await materializeForProfile()
  await expect(materializeMacDaemonBundle(copies, new AbortController().signal)).rejects.toThrow(
    "does not satisfy the app's signature"
  )
})
