import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  ensureRemoteOrcadNodeRuntime,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY,
  RemoteNodeRuntimeSecurityModifiedError,
  RemoteNodeRuntimeSelfTestError
} from './orcad-remote-node-runtime'
import {
  REMOTE_NODE_RUNTIME_EXIT_PREFIX,
  REMOTE_NODE_RUNTIME_SELFTEST_FAILED
} from './orcad-remote-node-runtime-report'
import { ensurePinnedRelayRuntime, verifyPinnedRelayInstall } from './ssh-relay-pinned-node-install'
import {
  PinnedRelayFallbackError,
  planPinnedNodeRelay,
  type PinnedRelayPlan
} from './ssh-relay-pinned-node'
import { resetPinnedRuntimeRefusalsForTests } from './ssh-relay-pinned-refusal-cache'
import { runPinnedRuntimeSelfTest } from './ssh-relay-runtime-self-test'
import type { HostNodeAddonRelayPlan } from './ssh-relay-host-node-addons'
import { RelayRuntimeLadderRun } from './ssh-relay-runtime-resolution'
import { withRuntimeStoreLock } from './remote-node-runtime-store-lock'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
vi.mock('./orcad-remote-node-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureRemoteOrcadNodeRuntime: vi.fn()
}))
vi.mock('./remote-node-runtime-store-lock', () => ({
  withRuntimeStoreLock: vi.fn((_conn, _host, _store, task: () => Promise<unknown>) => task())
}))
vi.mock('./ssh-relay-runtime-self-test', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPinnedRuntimeSelfTest: vi.fn()
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All connection operations are mocked.
const conn = {} as SshConnection
const host = getRemoteHostPlatform('linux-x64')
const plan: PinnedRelayPlan = {
  kind: 'pinned-node',
  target: 'linux-x64-glibc',
  glibc: { major: 2, minor: 31 },
  fullVersion: '0.1.0+feedfacecafe',
  addons: { dir: '/tmp/a', digest: 'd', dispose: async () => {} },
  runtimeArchive: async () => '/tmp/archive.tar.gz'
}
const context = {
  conn,
  host,
  remoteRelayDir: '/home/u/.orca-remote/relay-0.1.0+feedfacecafe',
  plan,
  targetId: 'target-1'
}

beforeEach(() => {
  vi.mocked(execCommand).mockReset()
  vi.mocked(ensureRemoteOrcadNodeRuntime).mockReset().mockResolvedValue({
    executable: '/home/u/.orca-remote/runtimes/node-test/bin/node',
    transfer: 'uploaded'
  })
  vi.mocked(runPinnedRuntimeSelfTest).mockReset()
  resetPinnedRuntimeRefusalsForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('ensurePinnedRelayRuntime', () => {
  it('trusts the verified marker on the warm path and never re-uploads', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce(REMOTE_NODE_RUNTIME_READY)
    await ensurePinnedRelayRuntime(context, true)
    expect(ensureRemoteOrcadNodeRuntime).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a library removed since the install',
      127,
      'libatomic.so.1: cannot open shared object file',
      'missing_lib'
    ],
    ['an exec policy that now denies it', 126, 'sh: node: Permission denied', 'noexec']
  ] as const)(
    'refuses a cached runtime that no longer runs (%s) before any launch',
    async (_label, status, output, reason) => {
      vi.mocked(execCommand).mockResolvedValueOnce(
        `${REMOTE_NODE_RUNTIME_SELFTEST_FAILED}\n${REMOTE_NODE_RUNTIME_EXIT_PREFIX}${status}\n${output}\n`
      )
      const failure = await ensurePinnedRelayRuntime(context, true).catch((e: unknown) => e)
      expect(failure).toMatchObject({ reason })
      expect(String(vi.mocked(execCommand).mock.calls[0]?.[1])).toContain('--version')
      expect(ensureRemoteOrcadNodeRuntime).not.toHaveBeenCalled()
    }
  )

  it('reinstalls a runtime that disappeared from under an installed relay', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce(REMOTE_NODE_RUNTIME_MISSING)
    await ensurePinnedRelayRuntime(context, true)
    expect(ensureRemoteOrcadNodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ slotDir: context.remoteRelayDir, target: 'linux-x64-glibc' })
    )
  })

  it('turns a classified runtime refusal into a remembered fallback', async () => {
    vi.mocked(ensureRemoteOrcadNodeRuntime).mockRejectedValueOnce(
      new RemoteNodeRuntimeSelfTestError(126, 'sh: node: Permission denied')
    )
    const failure = await ensurePinnedRelayRuntime(context, false).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PinnedRelayFallbackError)
    expect(failure).toMatchObject({ reason: 'noexec' })

    vi.mocked(execCommand).mockResolvedValueOnce('ldd (GNU libc) 2.31')
    await expect(
      planPinnedNodeRelay({ conn, host, baseVersion: '0.1.0+abc', targetId: 'target-1' })
    ).resolves.toEqual({ kind: 'host-node', fallbackReason: 'noexec', remembered: true })
  })

  it("steps down when NixOS's stub loader refuses the generic Linux runtime", async () => {
    vi.mocked(ensureRemoteOrcadNodeRuntime).mockRejectedValueOnce(
      new RemoteNodeRuntimeSelfTestError(
        127,
        'Could not start dynamically linked executable: /home/u/.orca-remote/runtimes/node-x/bin/node\n' +
          'NixOS cannot run dynamically linked executables intended for generic\n' +
          'linux environments out of the box. For more information, see:\n' +
          'https://nix.dev/permalink/stub-ld'
      )
    )
    const failure = await ensurePinnedRelayRuntime(context, false).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PinnedRelayFallbackError)
    expect(failure).toMatchObject({ reason: 'wrong_libc' })
  })

  it('keeps an unclassified runtime failure as an error, not a step down', async () => {
    const failure = new RemoteNodeRuntimeSelfTestError(1, 'something unexpected')
    vi.mocked(ensureRemoteOrcadNodeRuntime).mockRejectedValueOnce(failure)
    await expect(ensurePinnedRelayRuntime(context, false)).rejects.toBe(failure)
  })
})

describe('verifyPinnedRelayInstall', () => {
  beforeEach(() => {
    vi.mocked(execCommand).mockResolvedValue(REMOTE_NODE_RUNTIME_READY)
  })

  it('confirms the runtime under the store lock once the relay ref is visible', async () => {
    vi.mocked(runPinnedRuntimeSelfTest).mockResolvedValueOnce({ verdict: 'failed', detail: 'x' })
    await verifyPinnedRelayInstall(context).catch(() => {})
    expect(withRuntimeStoreLock).toHaveBeenCalledWith(
      conn,
      host,
      '/home/u/.orca-remote/runtimes',
      expect.any(Function),
      undefined
    )
    expect(ensureRemoteOrcadNodeRuntime).not.toHaveBeenCalled()
  })

  it('reinstalls a runtime a store GC collected before the ref existed', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce(REMOTE_NODE_RUNTIME_MISSING)
    vi.mocked(runPinnedRuntimeSelfTest).mockResolvedValueOnce({ verdict: 'failed', detail: 'x' })
    await verifyPinnedRelayInstall(context).catch(() => {})
    expect(ensureRemoteOrcadNodeRuntime).toHaveBeenCalledOnce()
  })

  it('passes a verified runtime through', async () => {
    vi.mocked(runPinnedRuntimeSelfTest).mockResolvedValueOnce({
      verdict: 'passed',
      report: {
        ok: true,
        nonce: 'n',
        node: 'v24.21.0',
        napi: '10',
        glibcVersionRuntime: '2.31',
        runtime: 'pinned-node'
      }
    })
    await expect(verifyPinnedRelayInstall(context)).resolves.toBeUndefined()
    expect(runPinnedRuntimeSelfTest).toHaveBeenCalledWith(
      conn,
      context.remoteRelayDir,
      expect.stringMatching(/\/\.orca-remote\/runtimes\/node-[0-9a-f]{64}\/bin\/node$/),
      undefined,
      { host, expectPinnedVersion: true }
    )
  })

  it('self-tests rung C on the host Node without the pinned version check or a cached refusal', async () => {
    vi.mocked(withRuntimeStoreLock).mockClear()
    vi.mocked(execCommand).mockResolvedValue('')
    const run = new RelayRuntimeLadderRun('target-1', null, true)
    const hostPlan: HostNodeAddonRelayPlan = {
      kind: 'host-node-addons',
      target: 'linux-x64-glibc',
      glibc: { major: 2, minor: 31 },
      fullVersion: '0.1.0+0123456789ab',
      addons: { dir: '/tmp/a', digest: 'd', dispose: async () => {} },
      nodePath: '/opt/node18/bin/node',
      hostNode: { version: { major: 18, minor: 20 }, napi: 9 }
    }
    vi.mocked(runPinnedRuntimeSelfTest).mockResolvedValueOnce({
      verdict: 'refused',
      refusal: 'libc_floor',
      detail: "GLIBC_2.33' not found"
    })
    await expect(
      verifyPinnedRelayInstall({ ...context, plan: hostPlan, run })
    ).rejects.toMatchObject({ reason: 'libc_floor' })
    expect(runPinnedRuntimeSelfTest).toHaveBeenCalledWith(
      conn,
      context.remoteRelayDir,
      '/opt/node18/bin/node',
      undefined,
      { host, expectPinnedVersion: false }
    )
    expect(run.selfTest).toBe('refused')
    // Rung C runs no managed runtime, so there is nothing to hold under the store lock.
    expect(withRuntimeStoreLock).not.toHaveBeenCalled()
    // A host Node refusal says nothing about Orca's pinned Node on this host.
    vi.mocked(execCommand).mockResolvedValueOnce('ldd (GNU libc) 2.31')
    const next = await planPinnedNodeRelay({
      conn,
      host,
      baseVersion: '0.1.0+abcdef012345',
      targetId: 'target-1',
      materializeOrcad: () => Promise.reject(new Error('stop here'))
    })
    expect(next).toMatchObject({ fallbackReason: 'artifacts_unavailable' })
  })

  it('falls back on a refusal', async () => {
    vi.mocked(runPinnedRuntimeSelfTest).mockResolvedValueOnce({
      verdict: 'refused',
      refusal: 'libc_floor',
      detail: "GLIBC_2.33' not found"
    })
    await expect(verifyPinnedRelayInstall(context)).rejects.toMatchObject({
      reason: 'libc_floor'
    })
  })

  it('never falls back on an unverifiable self-test', async () => {
    vi.mocked(runPinnedRuntimeSelfTest).mockResolvedValueOnce({
      verdict: 'unverifiable',
      detail: 'timed out'
    })
    const failure = await verifyPinnedRelayInstall(context).catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(PinnedRelayFallbackError)
    expect(String(failure)).toContain('unverifiable')
  })

  it('rethrows an unconfirmed teardown so the install lock stays held', async () => {
    const lost = Object.assign(new Error('lost'), { sshChannelCloseConfirmed: false })
    vi.mocked(runPinnedRuntimeSelfTest).mockResolvedValueOnce({
      verdict: 'unverifiable',
      detail: 'lost',
      cause: lost
    })
    await expect(verifyPinnedRelayInstall(context)).rejects.toBe(lost)
  })

  it('makes the macOS spawn-helper executable before the self-test', async () => {
    vi.mocked(execCommand).mockResolvedValue('')
    vi.mocked(runPinnedRuntimeSelfTest).mockResolvedValueOnce({ verdict: 'failed', detail: 'x' })
    await verifyPinnedRelayInstall({
      ...context,
      host: getRemoteHostPlatform('darwin-arm64'),
      plan: { ...plan, target: 'darwin-arm64' }
    }).catch(() => {})
    expect(execCommand).toHaveBeenCalledWith(
      conn,
      expect.stringContaining("node_modules/node-pty/build/Release/spawn-helper'"),
      expect.anything()
    )
  })
})

describe('pinned relay on a Windows host', () => {
  const windowsHost = getRemoteHostPlatform('win32-x64')
  const windowsContext = {
    ...context,
    host: windowsHost,
    remoteRelayDir: 'C:/Users/u/.orca-remote/relay-0.1.0+feedfacecafe',
    plan: { ...plan, target: 'win32-x64' as const, glibc: null }
  }

  it('checks the warm runtime through one unwrapped powershell.exe', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce(`${REMOTE_NODE_RUNTIME_READY}\r\n`)
    await ensurePinnedRelayRuntime(windowsContext, true)
    const [, command, options] = vi.mocked(execCommand).mock.calls[0]
    expect(command).toMatch(/^powershell\.exe /)
    expect(options).toMatchObject({ wrapCommand: false })
    expect(decodeRemotePowerShellScript(command)).toContain('/.orca-remote/runtimes/node-')
    expect(ensureRemoteOrcadNodeRuntime).not.toHaveBeenCalled()
  })

  it('steps down to host Node, and remembers it, when security software touched node.exe', async () => {
    vi.mocked(ensureRemoteOrcadNodeRuntime).mockRejectedValueOnce(
      new RemoteNodeRuntimeSecurityModifiedError('node.exe changed after it ran')
    )
    const failure = await ensurePinnedRelayRuntime(windowsContext, false).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(PinnedRelayFallbackError)
    expect(failure).toMatchObject({ reason: 'security_software' })
    await expect(
      planPinnedNodeRelay({
        conn,
        host: windowsHost,
        baseVersion: '0.1.0+abc',
        targetId: 'target-1'
      })
    ).resolves.toEqual({ kind: 'host-node', fallbackReason: 'security_software', remembered: true })
  })

  it('classifies application control blocking node.exe as a refusal', async () => {
    vi.mocked(ensureRemoteOrcadNodeRuntime).mockRejectedValueOnce(
      new RemoteNodeRuntimeSelfTestError(-1, 'This program is blocked by group policy.')
    )
    await expect(ensurePinnedRelayRuntime(windowsContext, false)).rejects.toMatchObject({
      reason: 'noexec'
    })
  })

  it('confirms the runtime under the store lock, then self-tests on node.exe with no chmod step', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce(`${REMOTE_NODE_RUNTIME_READY}\r\n`)
    vi.mocked(runPinnedRuntimeSelfTest).mockResolvedValueOnce({
      verdict: 'passed',
      report: {
        ok: true,
        nonce: 'n',
        node: 'v24.21.0',
        napi: '10',
        glibcVersionRuntime: null,
        runtime: 'pinned-node'
      }
    })
    await expect(verifyPinnedRelayInstall(windowsContext)).resolves.toBeUndefined()
    // Windows store GC collects too, so the held-runtime check runs there as well (design D5).
    expect(withRuntimeStoreLock).toHaveBeenCalledWith(
      conn,
      windowsHost,
      'C:/Users/u/.orca-remote/runtimes',
      expect.any(Function),
      undefined
    )
    expect(execCommand).toHaveBeenCalledOnce()
    const [, command, options] = vi.mocked(execCommand).mock.calls[0]
    expect(command).toMatch(/^powershell\.exe /)
    expect(options).toMatchObject({ wrapCommand: false })
    expect(runPinnedRuntimeSelfTest).toHaveBeenCalledWith(
      conn,
      windowsContext.remoteRelayDir,
      expect.stringMatching(
        /^C:\/Users\/u\/\.orca-remote\/runtimes\/node-[0-9a-f]{64}\/node\.exe$/
      ),
      undefined,
      { host: windowsHost, expectPinnedVersion: true }
    )
  })
})
