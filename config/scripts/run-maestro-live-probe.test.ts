import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import './maestro-live-probe-contracts.test.ts'
import { artifact, browserReceipt, targetsManifest } from './maestro-live-probe-fixtures'
import {
  type ProbeContractError,
  assertLaunchProfile,
  assertProfileDriftBlocksResult,
  createBrowserSurfaceRegistry,
  createImmutableCapsule,
  createOwnedResourceScope,
  installProbeSignalHandlers,
  resolveLaunchProfile,
  runBoundedCommand,
  runMaestroLiveProbe,
  validateProbeArtifact,
  validateTargetsManifest,
  verifyTargetRepositories
} from './run-maestro-live-probe.mjs'

type FakeChild = EventEmitter & {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(pid = 42): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn(() => true)
  return child
}

describe('Maestro live probe contracts', () => {
  it('validates explicit repository roots, revisions, workspace, and runtime command', () => {
    expect(validateTargetsManifest(targetsManifest())).toMatchObject({
      repositories: [
        { key: 'orca', root: '/tmp/orca-target' },
        { key: 'my-llm-kit', root: '/tmp/my-llm-kit-target' }
      ],
      execution_workspace: {
        workspace_key: 'folder:probe-workspace',
        browser_profile_id: 'profile-1'
      },
      expected_launch_profile: {
        provider: 'codex',
        model: 'terra',
        effort: 'medium',
        permission_mode: 'yolo',
        permission_argument: '--yolo'
      }
    })
    expect(
      validateTargetsManifest({
        ...targetsManifest(),
        orca: { ...targetsManifest().orca, root: '/tmp/orca-target/../orca-target' }
      }).repositories[0].root
    ).toBe('/tmp/orca-target')
    expect(() =>
      validateTargetsManifest({
        ...targetsManifest(),
        orca: { ...targetsManifest().orca, root: 'relative' }
      })
    ).toThrow('absolute path')
  })

  it('rejects a repository identity that differs from the manifest', () => {
    const manifest = targetsManifest()
    expect(() =>
      verifyTargetRepositories(manifest, (root, key) => ({
        root,
        revision: key === 'orca' ? 'a'.repeat(40) : 'b'.repeat(40),
        repository_id: key === 'orca' ? 'wrong-repository' : 'my-llm-kit-repository'
      }))
    ).toThrowError(
      expect.objectContaining<ProbeContractError>({ code: 'repository_identity_mismatch' })
    )
    expect(
      verifyTargetRepositories(manifest, (root, key) => ({
        root: key === 'orca' ? '/tmp/orca-target/../orca-target' : root,
        revision: key === 'orca' ? 'a'.repeat(40) : 'b'.repeat(40),
        repository_id: key === 'orca' ? 'orca-repository' : 'my-llm-kit-repository'
      })).repositories[0].root
    ).toBe('/tmp/orca-target')
  })

  it('captures bounded output and exact spawn options', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'ok')
        child.stderr.emit('data', 'warning')
        child.emit('close', 0, null)
      })
      return child
    })
    const result = await runBoundedCommand({
      command: 'probe-command',
      args: ['--json'],
      cwd: '/tmp/probe',
      maxOutputBytes: 64,
      spawnImpl: spawn
    })
    expect(result).toMatchObject({ status: 0, stdout: 'ok', stderr: 'warning', error_code: null })
    expect(spawn).toHaveBeenCalledWith(
      'probe-command',
      ['--json'],
      expect.objectContaining({
        cwd: '/tmp/probe',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
  })

  it('fails closed on spawn, signal, timeout, and output bounds', async () => {
    const spawnError = await runBoundedCommand({
      command: 'missing',
      spawnImpl: vi.fn(() => {
        throw new Error('not found')
      })
    })
    expect(spawnError.error_code).toBe('spawn_error')

    const signaledChild = fakeChild()
    const signaled = await runBoundedCommand({
      command: 'signaled',
      spawnImpl: vi.fn(() => {
        queueMicrotask(() => signaledChild.emit('close', null, 'SIGTERM'))
        return signaledChild
      })
    })
    expect(signaled.signal).toBe('SIGTERM')

    const timedChild = fakeChild()
    const timed = await runBoundedCommand({
      command: 'slow',
      timeoutMs: 5,
      spawnImpl: vi.fn(() => timedChild),
      killProcessGroup: vi.fn(() => timedChild.emit('close', null, 'SIGTERM'))
    })
    expect(timed.error_code).toBe('timeout')
    expect(timed.timed_out).toBe(true)

    const multiChunkChild = fakeChild()
    const multiChunk = await runBoundedCommand({
      command: 'multi-chunk',
      maxOutputBytes: 6,
      spawnImpl: vi.fn(() => {
        queueMicrotask(() => {
          multiChunkChild.stdout.emit('data', '12')
          multiChunkChild.stdout.emit('data', '34')
          multiChunkChild.stdout.emit('data', '56')
          multiChunkChild.emit('close', 0, null)
        })
        return multiChunkChild
      })
    })
    expect(multiChunk).toMatchObject({
      status: 0,
      stdout: '123456',
      output_truncated: false,
      error_code: null
    })

    const splitUtf8Child = fakeChild()
    const splitUtf8 = await runBoundedCommand({
      command: 'split-utf8',
      maxOutputBytes: 2,
      spawnImpl: vi.fn(() => {
        queueMicrotask(() => {
          splitUtf8Child.stdout.emit('data', Buffer.from([0xc3]))
          splitUtf8Child.stdout.emit('data', Buffer.from([0xa9]))
          splitUtf8Child.emit('close', 0, null)
        })
        return splitUtf8Child
      })
    })
    expect(splitUtf8).toMatchObject({
      status: 0,
      stdout: 'é',
      stderr: '',
      output_truncated: false,
      error_code: null
    })
    expect(splitUtf8.stdout).not.toContain('\uFFFD')
    expect(Buffer.byteLength(splitUtf8.stdout, 'utf8')).toBe(2)

    const outputChild = fakeChild()
    const outputLimited = await runBoundedCommand({
      command: 'loud',
      maxOutputBytes: 3,
      spawnImpl: vi.fn(() => {
        queueMicrotask(() => {
          outputChild.stdout.emit('data', '12')
          outputChild.stderr.emit('data', '34')
        })
        return outputChild
      }),
      killProcessGroup: vi.fn(() => outputChild.emit('close', null, 'SIGTERM'))
    })
    expect(outputLimited.error_code).toBe('output_limit')
    expect(outputLimited.stdout).toBe('12')
    expect(outputLimited.stderr).toBe('3')

    const unicodeChild = fakeChild()
    const unicodeLimited = await runBoundedCommand({
      command: 'unicode-loud',
      maxOutputBytes: 1,
      spawnImpl: vi.fn(() => {
        queueMicrotask(() => unicodeChild.stdout.emit('data', 'é'))
        return unicodeChild
      }),
      killProcessGroup: vi.fn(() => unicodeChild.emit('close', null, 'SIGTERM'))
    })
    expect(unicodeLimited.error_code).toBe('output_limit')
    expect(unicodeLimited.stdout).not.toContain('\uFFFD')
    expect(Buffer.byteLength(unicodeLimited.stdout, 'utf8')).toBeLessThanOrEqual(1)

    const controller = new AbortController()
    const abortChild = fakeChild(73)
    const killProcessGroup = vi.fn(() => abortChild.emit('close', null, 'SIGTERM'))
    const aborted = runBoundedCommand({
      command: 'abortable',
      platform: 'linux',
      signal: controller.signal,
      spawnImpl: vi.fn(() => abortChild),
      killProcessGroup
    })
    controller.abort('SIGTERM')
    await expect(aborted).resolves.toMatchObject({ error_code: 'aborted', signal: 'SIGTERM' })
    expect(killProcessGroup).toHaveBeenCalledWith(73, 'SIGTERM')

    vi.useFakeTimers()
    try {
      const alreadyAbortedController = new AbortController()
      alreadyAbortedController.abort('SIGTERM')
      const alreadyAbortedChild = fakeChild(74)
      const alreadyAbortedKill = vi.fn((_pid: number, signal: string) => {
        if (signal === 'SIGKILL') {
          alreadyAbortedChild.emit('close', null, 'SIGKILL')
        }
      })
      const alreadyAborted = runBoundedCommand({
        command: 'already-aborted',
        platform: 'linux',
        signal: alreadyAbortedController.signal,
        timeoutMs: 10,
        spawnImpl: vi.fn(() => alreadyAbortedChild),
        killProcessGroup: alreadyAbortedKill
      })
      await vi.advanceTimersByTimeAsync(50)
      await expect(alreadyAborted).resolves.toMatchObject({
        error_code: 'aborted',
        signal: 'SIGTERM'
      })
      expect(alreadyAbortedKill).toHaveBeenNthCalledWith(1, 74, 'SIGTERM')
      expect(alreadyAbortedKill).toHaveBeenNthCalledWith(2, 74, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates only bounded capsules and rejects retained private content', () => {
    const launchProfile = resolveLaunchProfile({
      provider: 'codex',
      model: 'terra',
      effort: 'medium'
    })
    const capsule = createImmutableCapsule({
      task: { id: 'ORC-01', contract: 'bounded task' },
      workspace_scope: { workspace_key: 'folder:probe-workspace' },
      evidence_refs: ['file:evidence.json'],
      launch_profile: launchProfile
    })
    expect(capsule.digest).toMatch(/^sha256:/)
    expect(capsule.byte_count).toBeLessThan(8192)
    expect(() =>
      createImmutableCapsule({
        task: { id: 'ORC-01', transcript: 'secret' },
        workspace_scope: { workspace_key: 'folder:probe-workspace' },
        launch_profile: launchProfile
      })
    ).toThrowError(
      expect.objectContaining<ProbeContractError>({ code: 'capsule_privacy_violation' })
    )
  })

  it('keeps provider permission policy and rejects launch profile drift', () => {
    const codex = resolveLaunchProfile({ provider: 'codex', model: 'terra', effort: 'medium' })
    const claude = resolveLaunchProfile({ provider: 'claude', model: 'sonnet', effort: 'low' })
    expect(codex.permission_argument).toBe('--yolo')
    expect(claude.permission_argument).toBe('--dangerously-skip-permissions')
    expect(() =>
      resolveLaunchProfile({
        provider: 'claude',
        model: 'sonnet',
        effort: 'low',
        permission_mode: 'auto'
      })
    ).toThrow('auto')
    expect(() => assertLaunchProfile(codex, { ...codex, model: 'luna' })).toThrowError(
      expect.objectContaining<ProbeContractError>({ code: 'launch_profile_drift' })
    )
    expect(assertProfileDriftBlocksResult(codex, { ...codex, model: 'luna' })).toEqual({
      accepted: false,
      reason: 'launch_profile_drift'
    })
    expect(assertProfileDriftBlocksResult(codex, { ...codex })).toEqual({
      accepted: false,
      reason: 'fresh_matching_launch_required'
    })
    expect(
      assertProfileDriftBlocksResult(
        codex,
        { ...codex },
        {
          fresh: false,
          phase: 'fresh_launch',
          session_id: 'session-new',
          prior_session_id: 'session-old',
          profile: codex
        }
      )
    ).toEqual({ accepted: false, reason: 'fresh_matching_launch_required' })
    expect(
      assertProfileDriftBlocksResult(
        codex,
        { ...codex },
        {
          fresh: true,
          phase: 'fresh_launch',
          session_id: 'session-new',
          prior_session_id: 'session-old',
          profile: { ...codex, model: 'luna' }
        }
      )
    ).toEqual({ accepted: false, reason: 'fresh_matching_launch_required' })
    expect(
      assertProfileDriftBlocksResult(
        codex,
        { ...codex },
        {
          fresh: true,
          phase: 'fresh_launch',
          session_id: 'session-new',
          prior_session_id: 'session-old',
          profile: codex
        }
      )
    ).toEqual({ accepted: true, reason: null, fresh_session_id: 'session-new' })
  })

  it('cleans only Harness-owned process, Browser, and child-worktree resources', async () => {
    const scope = createOwnedResourceScope()
    expect(() => scope.trackProcess({ owner: 'user', user_owned: true })).toThrow('Harness-owned')
    const stop = vi.fn(async () => ({ verdict: 'exited' }))
    const release = vi.fn(async () => ({ closed: true }))
    const retire = vi.fn(async () => ({ retired: true }))
    scope.trackProcess({ owner: 'harness', stop })
    scope.trackBrowser({ owner: 'harness', release })
    scope.trackChildWorktree({ owner: 'harness', retire })
    const cleanupReceipt = await scope.cleanup()
    expect(cleanupReceipt).toMatchObject({ repeated: false })
    expect(cleanupReceipt.processes).toHaveLength(1)
    expect(cleanupReceipt.processes[0]).toEqual({ verdict: 'exited' })
    expect(stop).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(retire).toHaveBeenCalledOnce()
    await expect(scope.cleanup()).resolves.toMatchObject({ repeated: true })
  })

  it('attempts every cleanup owner after a partial stop failure and aggregates the error', async () => {
    const scope = createOwnedResourceScope()
    const throwingStop = vi.fn(async () => {
      throw new Error('stop failed')
    })
    const invalidStop = vi.fn(async () => ({ verdict: 'unverifiable' }))
    const release = vi.fn(async () => ({ closed: true }))
    const retire = vi.fn(async () => ({ retired: true }))
    scope.trackProcess({ owner: 'harness', stop: throwingStop })
    scope.trackProcess({ owner: 'harness', stop: invalidStop })
    scope.trackBrowser({ owner: 'harness', release })
    scope.trackChildWorktree({ owner: 'harness', retire })
    await expect(scope.cleanup()).rejects.toMatchObject({
      code: 'cleanup_partial_failure',
      details: { failures: expect.any(Array) }
    })
    expect(throwingStop).toHaveBeenCalledOnce()
    expect(invalidStop).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(retire).toHaveBeenCalledOnce()
  })

  it('removes only its own signal handlers and preserves pre-existing listeners', () => {
    const signalTarget = new EventEmitter()
    const existing = vi.fn()
    signalTarget.on('SIGINT', existing)
    const controller = new AbortController()
    const remove = installProbeSignalHandlers(controller, signalTarget)
    remove()
    expect(signalTarget.listeners('SIGINT')).toContain(existing)
    expect(signalTarget.listenerCount('SIGTERM')).toBe(0)
  })

  it('runs the explicit runtime probe and writes an artifact only when requested', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'maestro-live-probe-test-'))
    try {
      const manifest = targetsManifest()
      const runArtifact = (candidate: ReturnType<typeof artifact>) =>
        runMaestroLiveProbe({
          targets: manifest,
          verifyRepositories: false,
          run: vi.fn(async () => ({
            status: 0,
            signal: null,
            stdout: JSON.stringify(candidate),
            stderr: '',
            error_code: null
          }))
        })
      const run = vi.fn(async () => ({
        status: 0,
        signal: null,
        stdout: JSON.stringify(artifact()),
        stderr: '',
        error_code: null
      }))
      const artifactPath = join(tempRoot, 'live-probe.json')
      await expect(
        runMaestroLiveProbe({ targets: manifest, verifyRepositories: false, artifactPath, run })
      ).resolves.toMatchObject({ task_id: 'ORC-11P' })
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ command: process.execPath, cwd: '/tmp/orca-target' })
      )
      expect(JSON.parse(await readFile(artifactPath, 'utf8')).task_id).toBe('ORC-11P')
      await expect(
        runMaestroLiveProbe({ targets: manifest, verifyRepositories: false, run })
      ).resolves.toMatchObject({
        task_id: 'ORC-11P'
      })
      const incompleteArtifact = artifact()
      delete incompleteArtifact.cleanup
      await expect(
        runMaestroLiveProbe({
          targets: manifest,
          verifyRepositories: false,
          run: vi.fn(async () => ({
            status: 0,
            signal: null,
            stdout: JSON.stringify(incompleteArtifact),
            stderr: '',
            error_code: null
          }))
        })
      ).rejects.toThrow('cleanup is required')

      const missingGateArtifact = artifact()
      delete missingGateArtifact.context_rollover
      await expect(
        runMaestroLiveProbe({
          targets: manifest,
          verifyRepositories: false,
          run: vi.fn(async () => ({
            status: 0,
            signal: null,
            stdout: JSON.stringify(missingGateArtifact),
            stderr: '',
            error_code: null
          }))
        })
      ).rejects.toThrow('context rollover is required')

      const invalidGateArtifact = artifact()
      invalidGateArtifact.fresh_launch_receipt.fresh = false
      await expect(
        runMaestroLiveProbe({
          targets: manifest,
          verifyRepositories: false,
          run: vi.fn(async () => ({
            status: 0,
            signal: null,
            stdout: JSON.stringify(invalidGateArtifact),
            stderr: '',
            error_code: null
          }))
        })
      ).rejects.toThrow('fresh_matching_launch_required')

      const mismatchedSessions = artifact()
      mismatchedSessions.fresh_launch_receipt.session_id = 'session-other'
      await expect(runArtifact(mismatchedSessions)).rejects.toThrow('session IDs do not match')

      const resumedSession = artifact()
      resumedSession.context_rollover.fresh_session.resumed = true
      await expect(runArtifact(resumedSession)).rejects.toThrow('fresh provider session')

      const emptySession = artifact()
      emptySession.context_rollover.old_session.session_id = ''
      await expect(runArtifact(emptySession)).rejects.toThrow('old_session.session_id')

      const emptyEvidence = artifact()
      emptyEvidence.browser_receipts[0].evidence_receipt = {}
      await expect(runArtifact(emptyEvidence)).rejects.toThrow('evidence protocol')

      const unreleasedBrowser = artifact()
      unreleasedBrowser.browser_receipts[0].state = 'active'
      await expect(runArtifact(unreleasedBrowser)).rejects.toThrow('released Harness-owned')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects a Browser surface whose observed visibility is quietly downgraded', () => {
    const registry = createBrowserSurfaceRegistry('folder:probe-workspace', 'profile-1')
    expect(() =>
      registry.open(
        browserReceipt('page-downgraded', 'visible', { observed_visibility: 'offscreen' })
      )
    ).toThrow('silently downgraded')
    expect(() =>
      registry.open(
        browserReceipt('page-upgraded', 'offscreen', { observed_visibility: 'visible' })
      )
    ).toThrow('silently downgraded')
  })

  it('keeps unavailable usage unavailable instead of reporting it as zero', () => {
    const targets = validateTargetsManifest(targetsManifest())
    const withoutUsage = artifact()
    delete (withoutUsage.coordination_telemetry as Record<string, unknown>).token_usage
    ;(withoutUsage.coordination_telemetry as Record<string, unknown>).cache_usage = null
    const validated = validateProbeArtifact(withoutUsage, targets)
    const telemetry = validated.coordination_telemetry as Record<string, unknown>
    expect('token_usage' in telemetry).toBe(false)
    expect(telemetry.cache_usage).toBeNull()
    expect(telemetry.token_usage).not.toBe(0)
    expect(() =>
      validateProbeArtifact(
        {
          ...artifact(),
          coordination_telemetry: { ...artifact().coordination_telemetry, token_usage: 0 }
        },
        targets
      )
    ).toThrow('token_usage must be omitted, null, or an object')
  })

  it('rejects a self-attested launch profile that diverges from the manifest', async () => {
    const manifest = targetsManifest()
    const divergentProfile = resolveLaunchProfile({
      provider: 'codex',
      model: 'luna',
      effort: 'low'
    })
    const spoofedArtifact = artifact()
    spoofedArtifact.expected_launch_profile = divergentProfile
    spoofedArtifact.observed_launch_profile = divergentProfile
    spoofedArtifact.fresh_launch_receipt.profile = divergentProfile
    await expect(
      runMaestroLiveProbe({
        targets: manifest,
        verifyRepositories: false,
        run: vi.fn(async () => ({
          status: 0,
          signal: null,
          stdout: JSON.stringify(spoofedArtifact),
          stderr: '',
          error_code: null
        }))
      })
    ).rejects.toThrow('caller-pinned launch profile')
  })
})
