import { buildNetworkSshPolicyEnv } from '../git-environment/git-ssh-policy-env'
import { captureGitExecutionContext } from './wsl-git-path-preparation'
import {
  pendingWslWindowsCheckoutGitConfig,
  resetWslWindowsCheckoutProbesForTests
} from './wsl-windows-checkout-git-probe'
import { PLAIN_WINDOWS_CLONE_SAMPLE } from './wsl-windows-checkout-line-endings.test-fixture'
import { spawnSync } from 'node:child_process'
import type * as Admission from '../admission/git-subprocess-admission'
import type * as ProcessHost from '@orca/process-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { read, capture, admissionWait, environmentWait } = vi.hoisted(() => ({
  read: vi.fn(),
  capture: vi.fn(),
  admissionWait: vi.fn(),
  environmentWait: vi.fn()
}))
vi.mock('../../../wsl/execution/wsl-guest-environment', () => ({
  getWslGuestEnvironment: (...args: unknown[]) => environmentWait(...args)
}))
vi.mock('../process-capture/exec-file-capture', () => ({
  execFileCapture: capture,
  execFileCaptureToTermination: capture
}))
vi.mock('../admission/git-subprocess-admission', async (original) => {
  const actual = await original<typeof Admission>()
  return {
    ...actual,
    acquireGitAdmission: async (request: Parameters<typeof actual.acquireGitAdmission>[0]) => {
      await admissionWait()
      return actual.acquireGitAdmission(request)
    }
  }
})
vi.mock('@orca/process-host', async (original) => ({
  ...(await original<typeof ProcessHost>()),
  runProcess: read
}))

import {
  ensureWslAutomountRoot,
  captureWslAutomountSnapshot,
  settleWslAutomountSnapshot,
  resetWslAutomountRootsForTests
} from '../../../wsl/filesystem/wsl-automount-root'
import { noteWslDistroMayHaveStopped } from '../../../wsl/discovery/wsl-background-distro-gate'
import {
  gitResultPathTranslator,
  translateArgForWsl,
  translateWslOutputPaths
} from './wsl-path-translation'
import { bulkPathspecCommands } from '../../source-control/git-pathspec'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from '../git-exec-file'
import {
  setLocalGitRuntimeRouter,
  setBackgroundWslGitGate,
  resetWslGitAdmissionForTests
} from './local-git-runtime-route'
import {
  prepareWslLinkedWorktreeGitRouting,
  WSL_LINKED_WORKTREE_ROUTE_TTL_MS,
  seedWslLinkedWorktreeGitRoutingForTests,
  resetWslLinkedWorktreeGitRoutingForTests
} from './wsl-linked-worktree-git-routing'
import {
  recordHostAutocrlf,
  wslWindowsCheckoutKey,
  withWslWindowsCheckoutGitConfig,
  resetWslWindowsCheckoutGitConfigForTests
} from './wsl-windows-checkout-git-config'
import { resolveCommand } from './wsl-command-resolution'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function rootReply(args: string[], root: string) {
  const command = args.at(-1) ?? ''
  const nonce = /__ORCA_WSL_CAPTURE_BEGIN_ (\w+)__/.exec(command)?.[1]
  return {
    code: 0,
    timedOut: false,
    stderr: '',
    stdout: `__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${root}c/\n__ORCA_WSL_CAPTURE_END_${nonce}__`
  }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  resetWslAutomountRootsForTests()
  read.mockReset()
  environmentWait.mockReset().mockResolvedValue(null)
  capture.mockReset().mockImplementation(async (_binary, _args, options) => {
    options.onChildTerminated?.()
    return {
      stdout: options.encoding === 'buffer' ? Buffer.from('host result') : 'host result',
      stderr: ''
    }
  })
  admissionWait.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  resetWslAutomountRootsForTests()
  resetWslLinkedWorktreeGitRoutingForTests()
  resetWslWindowsCheckoutGitConfigForTests()
  resetWslWindowsCheckoutProbesForTests()
  resetWslGitAdmissionForTests()
  setLocalGitRuntimeRouter(null)
  vi.restoreAllMocks()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

it('keeps selected-distro drive and UNC identities through cold reads, cancellation and restart', async () => {
  const release = Promise.withResolvers<void>()
  read.mockImplementation(async ({ args }: { args: string[] }) => {
    await release.promise
    return rootReply(args, args[1] === 'Custom' ? '/qamnt/' : '/mnt/')
  })
  const aborted = new AbortController()
  const canceled = ensureWslAutomountRoot('Custom', aborted.signal)
  const surviving = ensureWslAutomountRoot('Custom')
  aborted.abort()
  await expect(canceled).rejects.toBe(aborted.signal.reason)
  release.resolve()
  await surviving
  await ensureWslAutomountRoot('Default')

  expect(translateArgForWsl(String.raw`C:\repo`, 'Custom')).toBe('/qamnt/c/repo')
  expect(translateArgForWsl(String.raw`C:\repo`, 'Default')).toBe('/mnt/c/repo')
  expect(
    translateWslOutputPaths('worktree /qamnt/c/repo\n', String.raw`C:\repo`, {
      wslDistro: 'Custom'
    })
  ).toBe('worktree C:\\repo\n')
  expect(
    translateWslOutputPaths(
      'worktree /qamnt/c/repo\n',
      String.raw`\\wsl.localhost\Custom\qamnt\c\repo`
    )
  ).toBe('worktree \\\\wsl.localhost\\Custom\\qamnt\\c\\repo\n')
  expect(
    translateWslOutputPaths('worktree /mnt/c/ordinary\n', String.raw`C:\repo`, {
      wslDistro: 'Custom'
    })
  ).toBe('worktree \\\\wsl.localhost\\Custom\\mnt\\c\\ordinary\n')

  noteWslDistroMayHaveStopped('Custom')
  read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/new/'))
  await ensureWslAutomountRoot('Custom')
  expect(translateArgForWsl(String.raw`C:\repo`, 'Custom')).toBe('/new/c/repo')
  expect(translateArgForWsl(String.raw`C:\repo`, 'Default')).toBe('/mnt/c/repo')
})

it.skipIf(process.platform === 'win32')(
  'runs cold immediate shell operands literally and never invokes the program after conversion fails',
  () => {
    const command = resolveCommand(
      '/usr/bin/printf',
      ['%s\n', "C:\\space\\$value\\O'Brien\nnext"],
      undefined,
      'Custom',
      {
        cwdFailureExitCode: 77
      }
    )
    const payload = command.args.at(-1) ?? ''
    const success = spawnSync(
      '/bin/bash',
      ['-c', `wslpath() { printf %s /qamnt/c/; }; ${payload}`],
      {
        encoding: 'utf8'
      }
    )
    expect(success.status).toBe(0)
    expect(success.stdout).toBe("/qamnt/c/space/$value/O'Brien\nnext\n")
    const failure = spawnSync('/bin/bash', ['-c', `wslpath() { return 73; }; ${payload}`], {
      encoding: 'utf8'
    })
    expect(failure.status).toBe(77)
    expect(failure.stdout).toBe('')
  }
)

it('lets a restarted request complete before the obsolete root read settles', async () => {
  const obsolete = Promise.withResolvers<void>()
  let first = true
  read.mockImplementation(async ({ args }: { args: string[] }) => {
    if (first) {
      first = false
      await obsolete.promise
      return rootReply(args, '/old/')
    }
    return rootReply(args, '/new/')
  })
  const old = ensureWslAutomountRoot('Custom')
  await Promise.resolve()
  noteWslDistroMayHaveStopped('Custom')
  await expect(ensureWslAutomountRoot('Custom')).resolves.toBe('/new/')
  obsolete.resolve()
  await expect(old).resolves.toBe('/new/')
  expect(translateArgForWsl('C:\\repo', 'Custom')).toBe('/new/c/repo')
})

it('keeps cold UNC output usable without guessing a Windows mount', () => {
  expect(
    translateWslOutputPaths(
      'worktree /home/me/repo\n',
      String.raw`\\wsl.localhost\Custom\home\me\repo`
    )
  ).toBe('worktree \\\\wsl.localhost\\Custom\\home\\me\\repo\n')
})

it('sizes a cold host-owned linked checkout without a guest root', async () => {
  seedWslLinkedWorktreeGitRoutingForTests(String.raw`C:\repo\linked`)
  await expect(
    bulkPathspecCommands(['add', '--'], ['file.txt'], String.raw`C:\repo\linked`, {
      wslDistro: 'Custom'
    })
  ).resolves.toEqual([['add', '--', ':(literal)file.txt']])
})

it.each([750, 7500])(
  'sizes %s warm background paths without another distro admission',
  async (count) => {
    read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/qamnt/'))
    await ensureWslAutomountRoot('Custom')
    setLocalGitRuntimeRouter(() => 'Custom')
    const gate = vi.fn(async () => true)
    setBackgroundWslGitGate(gate)
    for (let i = 0; i < count; i++) {
      await expect(
        bulkPathspecCommands(['ls-files', '--'], ['file.txt'], String.raw`C:\repo`, {
          admissionTier: 'background'
        })
      ).resolves.toEqual([['ls-files', '--', ':(literal)file.txt']])
    }
    expect(gate).not.toHaveBeenCalled()
    noteWslDistroMayHaveStopped('Custom')
    gate.mockResolvedValue(false)
    await expect(
      bulkPathspecCommands(['ls-files', '--'], [], String.raw`C:\repo`, {
        admissionTier: 'background'
      })
    ).resolves.toEqual([])
    expect(gate).not.toHaveBeenCalled()
    await expect(
      bulkPathspecCommands(['ls-files', '--'], ['file.txt'], String.raw`C:\repo`, {
        admissionTier: 'background'
      })
    ).rejects.toMatchObject({ reason: 'distro-stopped' })
    expect(read).toHaveBeenCalledTimes(1)
  }
)

it('never launches queued Git with the root invalidated during admission', async () => {
  read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/old/'))
  await ensureWslAutomountRoot('Custom')
  recordHostAutocrlf(wslWindowsCheckoutKey(String.raw`C:\repo`, 'Custom'), 'other', Date.now())
  admissionWait.mockImplementationOnce(async () => {
    noteWslDistroMayHaveStopped('Custom')
  })
  await expect(
    gitExecFileAsync(['restore', '--worktree', '--', 'file'], {
      cwd: String.raw`C:\repo`,
      wslDistro: 'Custom'
    })
  ).rejects.toThrow("couldn't read Windows drive paths")
  expect(capture).not.toHaveBeenCalled()
  read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/new/'))
  await expect(
    gitExecFileAsync(['restore', '--worktree', '--', 'file'], {
      cwd: String.raw`C:\repo`,
      wslDistro: 'Custom'
    })
  ).resolves.toEqual({ stdout: 'host result', stderr: '' })
  expect(capture.mock.calls[0]?.[1]?.join(' ')).toContain('/new/c/repo')
})

it.each([gitExecFileAsync, gitExecFileAsyncBuffer])(
  'retains a finite host-linked route across an admission longer than its TTL (%s)',
  async (run) => {
    const cwd = String.raw`C:\repo\linked`
    const now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    await prepareWslLinkedWorktreeGitRouting(cwd, 'Custom', {
      fileSystem: {
        stat: async () => ({ isDirectory: () => false, isFile: () => true }),
        readFile: async () => 'gitdir: C:/repo/.git/worktrees/linked\n'
      }
    })
    admissionWait.mockImplementationOnce(async () => {
      clock.mockReturnValue(now + WSL_LINKED_WORKTREE_ROUTE_TTL_MS + 1)
    })
    await run(['status', '--short'], { cwd, wslDistro: 'Custom' })
    expect(capture.mock.calls[0]?.[0]).toBe('git')
    expect(capture.mock.calls[0]?.[2]?.cwd).toBe(String.raw`C:\repo\linked`)
    expect(read).not.toHaveBeenCalled()
  }
)

it('interprets completed worktree bytes in their producing epoch, and settles a cold UNC epoch', async () => {
  read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/old/'))
  await ensureWslAutomountRoot('Custom')
  const completed = {
    executionContext: { kind: 'wsl' as const, paths: captureWslAutomountSnapshot('Custom') }
  }
  noteWslDistroMayHaveStopped('Custom')
  read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/new/'))
  await ensureWslAutomountRoot('Custom')
  const translate = await gitResultPathTranslator(completed, String.raw`C:\repo`, {
    wslDistro: 'Custom'
  })
  expect(translate('/old/c/wt')).toBe(String.raw`C:\wt`)
  expect(translate('/old/c/wt\nsecond line')).toBe('C:\\wt\nsecond line')
  resetWslAutomountRootsForTests()
  read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/mnt/'))
  const cold = {
    executionContext: { kind: 'wsl' as const, paths: captureWslAutomountSnapshot('Default') }
  }
  const fromUNC = await gitResultPathTranslator(
    cold,
    String.raw`\\wsl.localhost\Default\home\me\repo`
  )
  expect(fromUNC('/mnt/c/wt')).toBe(String.raw`C:\wt`)
})

it('does not start optional metadata discovery after a stop between scheduling and invocation', async () => {
  const snapshot = captureWslAutomountSnapshot('Custom')
  const settlement = settleWslAutomountSnapshot(snapshot)
  noteWslDistroMayHaveStopped('Custom')
  await expect(settlement).resolves.toMatchObject({ root: null })
  expect(read).not.toHaveBeenCalled()
  const toHostPath = await gitResultPathTranslator(
    { executionContext: { kind: 'wsl', paths: snapshot } },
    String.raw`\\wsl.localhost\Custom\home\me\repo`
  )
  expect(toHostPath('/qamnt/c/wt')).toBe(String.raw`\\wsl.localhost\Custom\qamnt\c\wt`)
  read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/new/'))
  await expect(ensureWslAutomountRoot('Custom')).resolves.toBe('/new/')
})

it('fences the SSH policy probe after admission before any stale cwd reaches capture', async () => {
  read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/old/'))
  await ensureWslAutomountRoot('Custom')
  const options = {
    cwd: String.raw`C:\repo`,
    wslDistro: 'Custom',
    executionContext: captureGitExecutionContext({ cwd: String.raw`C:\repo`, wslDistro: 'Custom' })
  }
  admissionWait.mockImplementationOnce(async () => {
    noteWslDistroMayHaveStopped('Custom')
  })
  await expect(buildNetworkSshPolicyEnv(options, ['fetch'])).rejects.toThrow(
    "couldn't read Windows drive paths"
  )
  expect(capture).not.toHaveBeenCalled()
})

it('discards checkout EOL evidence when its prepared path expires during the preferred environment wait', async () => {
  const cwd = String.raw`C:\repo`
  const key = wslWindowsCheckoutKey(cwd, 'Custom')
  read.mockImplementation(async ({ args }: { args: string[] }) => rootReply(args, '/old/'))
  await ensureWslAutomountRoot('Custom')
  recordHostAutocrlf(key, 'true', Date.now())
  environmentWait.mockImplementationOnce(async () => {
    noteWslDistroMayHaveStopped('Custom')
    return null
  })
  const deps = {
    checkoutIdentity: async () => 'clone',
    admit: async () => ({ queueWaitMs: 0, release: () => {} })
  }
  await pendingWslWindowsCheckoutGitConfig(
    ['add', '--', 'file'],
    { cwd, wslDistro: 'Custom' },
    deps
  )
  expect(withWslWindowsCheckoutGitConfig(['add'], cwd, 'Custom')).not.toContain(
    'core.autocrlf=true'
  )
  resetWslWindowsCheckoutProbesForTests()
  read.mockImplementation(async ({ args }: { args: string[] }) => {
    if (args.at(-1)?.includes('wslpath')) {
      return rootReply(args, '/new/')
    }
    expect(args).toContain('/new/c/repo')
    return { code: 0, timedOut: false, stdout: PLAIN_WINDOWS_CLONE_SAMPLE, stderr: '' }
  })
  await ensureWslAutomountRoot('Custom')
  await pendingWslWindowsCheckoutGitConfig(
    ['add', '--', 'file'],
    { cwd, wslDistro: 'Custom' },
    deps
  )
  expect(withWslWindowsCheckoutGitConfig(['add'], cwd, 'Custom')).toContain('core.autocrlf=true')
})
