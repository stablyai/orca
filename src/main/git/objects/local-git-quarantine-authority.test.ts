import type * as Fs from 'node:fs/promises'
import type * as Capture from '../command-runner/process-capture/exec-file-capture'
import type * as Admission from '../command-runner/admission/git-subprocess-admission'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  allocate: vi.fn(),
  remove: vi.fn(),
  capture: vi.fn(),
  beforeAdmission: vi.fn()
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof Fs>()),
  stat: async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  },
  mkdtemp: fixture.allocate,
  readdir: async () => [],
  rm: fixture.remove
}))
vi.mock('../command-runner/process-capture/exec-file-capture', async (original) => ({
  ...(await original<typeof Capture>()),
  execFileCapture: fixture.capture
}))
vi.mock('../command-runner/admission/git-subprocess-admission', async (original) => {
  const actual = await original<typeof Admission>()
  return {
    ...actual,
    acquireGitAdmission: async (request: Parameters<typeof actual.acquireGitAdmission>[0]) => {
      await fixture.beforeAdmission(request.args)
      return actual.acquireGitAdmission(request)
    }
  }
})

import { settleWslAutomountRoot } from '../../wsl/filesystem/__fixtures__/wsl-automount-root-fixture'
import { resetWslAutomountRootsForTests } from '../../wsl/filesystem/wsl-automount-root'
import {
  noteWslDistroMayHaveStopped,
  WSL_STOP_SETTLE_MS,
  _resetWslBackgroundDistroGateForTests
} from '../../wsl/discovery/wsl-background-distro-gate'
import { _resetRunningWslDistroCacheForTests } from '../../wsl/discovery/wsl-running-distro-cache'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import { _resetGitAdmissionForTests } from '../command-runner/admission/git-subprocess-admission'
import {
  clearGitCapabilityStateForTests,
  getLocalGitCapabilityCache
} from '../command-runner/host-routing/git-capability-state'
import {
  setLocalGitRuntimeRouter,
  resetWslGitAdmissionForTests
} from '../command-runner/host-routing/local-git-runtime-route'
import { resetWslLinkedWorktreeGitRoutingForTests } from '../command-runner/host-routing/wsl-linked-worktree-git-routing'
import { createLocalGitObjectQuarantine } from './local-git-object-quarantine'
import { localBranchHasNoUnmergedChanges } from '../refs/resolution/local-branch-merge-proof'
import { mergedReviewHeadIsEquivalent } from '../../source-control/merged-review-head-equivalence'
import {
  __resetPRConflictSummaryCachesForTests,
  getPRConflictSummary,
  setPRConflictSummaryRemoteFetches
} from '../../github/pull-requests/conflicts/conflict-summary'

const cwd = String.raw`\\wsl.localhost\Custom\home\me\repo`
const scratch = String.raw`C:\repo\.git\objects\tmp_objdir-orca-merge-tree-run`
const originalPlatform = process.platform

async function restart(): Promise<void> {
  const now = performance.now()
  noteWslDistroMayHaveStopped('Custom')
  vi.spyOn(performance, 'now').mockReturnValue(now + WSL_STOP_SETTLE_MS + 1)
  await settleWslAutomountRoot('Custom', '/new/')
}

beforeEach(async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  resetWslAutomountRootsForTests()
  __resetPRConflictSummaryCachesForTests()
  clearGitCapabilityStateForTests()
  await settleWslAutomountRoot('Custom', '/old/')
  fixture.remove.mockReset().mockResolvedValue(undefined)
  fixture.allocate.mockReset().mockResolvedValue(scratch)
  fixture.beforeAdmission.mockReset().mockResolvedValue(undefined)
  fixture.capture.mockReset().mockImplementation(async (_binary, args, options) => {
    options.onChildTerminated?.()
    return {
      stdout: args.join(' ').includes('rev-parse') ? '/old/c/repo/.git\n' : 'safe',
      stderr: ''
    }
  })
})
afterEach(() => {
  resetWslAutomountRootsForTests()
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  _resetGitAdmissionForTests()
  resetWslGitAdmissionForTests()
  resetWslLinkedWorktreeGitRoutingForTests()
  setLocalGitRuntimeRouter(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

it.each(['allocation', 'admission'])(
  'falls back before launching an obsolete quarantine after %s, and cleans the exact scratch store',
  async (boundary) => {
    if (boundary === 'allocation') {
      fixture.allocate.mockImplementationOnce(async () => {
        await restart()
        return scratch
      })
    } else {
      fixture.beforeAdmission.mockImplementation(async (args: string[]) => {
        if (args.includes('merge-tree')) {
          await restart()
        }
      })
    }
    const quarantine = createLocalGitObjectQuarantine(cwd)
    await expect(
      quarantine.run((env, canStart) =>
        gitExecFileAsync(['merge-tree', '--write-tree', 'HEAD', 'other'], { cwd, env, canStart })
      )
    ).resolves.toMatchObject({ stdout: 'safe' })
    const launched = fixture.capture.mock.calls.filter(([, args]) =>
      args.join(' ').includes('merge-tree')
    )
    expect(launched).toHaveLength(1)
    expect(launched[0]?.[1]?.join(' ')).not.toContain('GIT_OBJECT_DIRECTORY=')
    expect(fixture.remove).toHaveBeenCalledWith(scratch, { recursive: true, force: true })
  }
)

it.each(['unforwarded', 'unsafe forwarded'])(
  'uses the actual router-selected guest namespace for conflict preview with %s inherited stores',
  async (inheritance) => {
    const driveCwd = String.raw`C:\repo`
    resetWslAutomountRootsForTests()
    await settleWslAutomountRoot('Custom', '/qamnt/')
    setLocalGitRuntimeRouter(() => 'Custom')
    getLocalGitCapabilityCache({ cwd: driveCwd }).rememberSupported('merge-tree-write-tree')
    vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', String.raw`C:\other\objects`)
    vi.stubEnv(
      'WSLENV',
      inheritance === 'unsafe forwarded' ? 'GIT_ALTERNATE_OBJECT_DIRECTORIES' : ''
    )
    setPRConflictSummaryRemoteFetches({
      refreshRemoteTrackingBaseForPreview: async () => ({ ok: true })
    })
    fixture.capture.mockImplementation(async (_binary, args: string[], options) => {
      options.onChildTerminated?.()
      return {
        stdout: args.join(' ').includes('--git-common-dir')
          ? '/qamnt/c/repo/.git\n'
          : args.join(' ').includes('merge-tree')
            ? 'tree-oid\0file.ts\0'
            : 'safe',
        stderr: ''
      }
    })
    await expect(
      getPRConflictSummary(driveCwd, 'main', 'base-oid', 'head-oid')
    ).resolves.toMatchObject({
      files: ['file.ts']
    })
    const launched = fixture.capture.mock.calls.filter(([, args]) =>
      args.join(' ').includes('merge-tree')
    )
    expect(launched).toHaveLength(1)
    expect(launched[0]?.[1]?.slice(0, 3)).toEqual(['-d', 'Custom', '--exec'])
    const command = launched[0]?.[1]?.join(' ') ?? ''
    if (inheritance === 'unforwarded') {
      expect(command).toContain('/qamnt/c/repo/.git/objects/tmp_objdir-orca-merge-tree-run')
      expect(command).toContain('/qamnt/c/repo/.git/objects')
      expect(command).not.toContain('C:\\other\\objects')
      expect(fixture.allocate).toHaveBeenCalledWith(
        String.raw`C:\repo\.git\objects\tmp_objdir-orca-merge-tree-`
      )
      expect(fixture.remove).toHaveBeenCalledWith(scratch, { recursive: true, force: true })
    } else {
      expect(command).not.toContain('GIT_OBJECT_DIRECTORY=')
      expect(fixture.allocate).not.toHaveBeenCalled()
    }
  }
)

it('propagates cancellation without an unquarantined retry', async () => {
  const controller = new AbortController()
  fixture.allocate.mockImplementationOnce(async () => {
    controller.abort(new Error('canceled'))
    return scratch
  })
  const command = vi.fn((env, canStart) =>
    gitExecFileAsync(['merge-tree', '--write-tree', 'HEAD', 'other'], {
      cwd,
      env,
      canStart,
      signal: controller.signal
    })
  )
  await expect(
    createLocalGitObjectQuarantine(cwd, { signal: controller.signal }).run(command)
  ).rejects.toThrow('canceled')
  expect(command).not.toHaveBeenCalled()
  expect(fixture.remove).toHaveBeenCalledWith(scratch, { recursive: true, force: true })
})

it.each(['branch proof', 'conflict preview', 'review equivalence'])(
  'forwards quarantine authority through the actual %s caller',
  async (caller) => {
    getLocalGitCapabilityCache({ cwd }).rememberSupported('merge-tree-write-tree')
    fixture.capture.mockImplementation(async (_binary, args: string[], options) => {
      options.onChildTerminated?.()
      const command = args.join(' ')
      if (caller === 'review equivalence') {
        return {
          stdout: command.includes('--git-common-dir')
            ? '/old/c/repo/.git\n'
            : command.includes('refs/remotes/')
              ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
              : command.includes('merge-base')
                ? 'cccccccccccccccccccccccccccccccccccccccc'
                : !command.includes('merge-tree') &&
                    command.includes('cccccccccccccccccccccccccccccccccccccccc')
                  ? 'dddddddddddddddddddddddddddddddddddddddd'
                  : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          stderr: ''
        }
      }
      return {
        stdout: command.includes('--git-common-dir')
          ? '/old/c/repo/.git\n'
          : command.includes('merge-tree') && command.includes('--name-only')
            ? 'tree-oid\0file.ts\0'
            : 'safe',
        stderr: ''
      }
    })
    fixture.beforeAdmission.mockImplementation(async (args: string[]) => {
      if (args.includes('merge-tree')) {
        await restart()
      }
    })
    if (caller === 'branch proof') {
      await expect(
        localBranchHasNoUnmergedChanges({
          cwd,
          branchName: 'feature',
          targetRefs: ['HEAD'],
          refreshRemoteTargets: false
        })
      ).resolves.toBe(true)
    } else if (caller === 'review equivalence') {
      await expect(
        mergedReviewHeadIsEquivalent({
          repoPath: cwd,
          localGitOptions: {},
          reviewHeadOid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          baseBranchName: 'main',
          headOid: 'ffffffffffffffffffffffffffffffffffffffff'
        })
      ).resolves.toBe(true)
    } else {
      setPRConflictSummaryRemoteFetches({
        refreshRemoteTrackingBaseForPreview: async () => ({ ok: true })
      })
      await expect(
        getPRConflictSummary(cwd, 'main', 'base-oid', 'head-oid')
      ).resolves.toMatchObject({
        files: ['file.ts']
      })
    }
    const launched = fixture.capture.mock.calls.filter(([, args]) =>
      args.join(' ').includes('merge-tree')
    )
    expect(launched).toHaveLength(1)
    expect(launched[0]?.[1]?.join(' ')).not.toContain('GIT_OBJECT_DIRECTORY=')
    expect(fixture.remove).toHaveBeenCalledWith(scratch, { recursive: true, force: true })
  }
)
