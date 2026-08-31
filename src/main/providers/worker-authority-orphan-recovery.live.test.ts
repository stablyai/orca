import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync, spawnProcess } from '../../shared/child-process/run-process'
import {
  NO_GITHUB_AUTHORITY_POLICY,
  NO_GITHUB_AUTHORITY_POLICY_DIGEST
} from '../../shared/worker-authority-policy'
import {
  prepareWorkerAuthorityIsolation,
  WORKER_AUTHORITY_DOCKER_PATH,
  WORKER_AUTHORITY_IMAGE
} from './worker-authority-isolation'
import { recoverOrphanedWorkerAuthorityContainers } from './worker-authority-orphan-recovery'

const LIVE_DOCKER = process.env.ORCA_LIVE_WORKER_AUTHORITY_DOCKER === '1'

async function waitForCid(path: string): Promise<string> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim()
      if (/^[0-9a-f]{64}$/.test(value)) {
        return value
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function waitForContainerRunning(cid: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const status = runProcessSync({
      program: WORKER_AUTHORITY_DOCKER_PATH,
      args: ['inspect', '--format', '{{.State.Status}}', cid],
      timeoutMs: 5_000
    }).stdout.trim()
    if (status === 'running') {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for container ${cid}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.skipIf(!LIVE_DOCKER)('worker authority live Docker recovery', () => {
  it('removes the exact labeled container after its Docker client is killed', async () => {
    const tempRoot = mkdtempSync('/private/tmp/orca-authority-live-recovery-')
    const hostHome = join(tempRoot, 'host-home')
    const codexHome = join(hostHome, 'worker-codex')
    const workspacePath = join(tempRoot, 'repo')
    const lifecycleDirectory = join(tempRoot, 'lifecycle')
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(join(workspacePath, '.git'), { recursive: true })
    mkdirSync(lifecycleDirectory)
    writeFileSync(join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"synthetic-worker"}\n', {
      mode: 0o600
    })
    writeFileSync(join(workspacePath, '.git', 'config'), '[core]\n  bare = false\n')

    let cid = ''
    try {
      const prepared = prepareWorkerAuthorityIsolation({
        request: {
          schemaVersion: 'worker_authority_launch/1',
          policy: NO_GITHUB_AUTHORITY_POLICY,
          policyDigest: NO_GITHUB_AUTHORITY_POLICY_DIGEST,
          capabilityRef: `sha256:${'1'.repeat(64)}`,
          dispatchId: 'dispatch_live_recovery',
          worktreeId: 'worktree_live_recovery',
          setupPolicy: 'skip',
          imageDigest: WORKER_AUTHORITY_IMAGE,
          lifecycleDirectory,
          lifecycleBinding: `sha256:${'2'.repeat(64)}`
        },
        owner: {
          schemaVersion: 'worker_authority_daemon_owner/1',
          pid: process.pid,
          startedAtMs: Date.now() - process.uptime() * 1000,
          launchNonce: 'live-orphan-recovery',
          socketPath: join(tempRoot, 'daemon.sock'),
          tokenPath: join(tempRoot, 'daemon.token')
        },
        agent: 'codex',
        env: {
          HOME: process.env.HOME ?? hostHome,
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          ORCA_WORKER_CODEX_HOME: codexHome
        },
        authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: codexHome },
        workspacePath,
        command: 'codex',
        platform: 'darwin',
        hostHome,
        tempRoot
      })
      const isolationRoot = dirname(prepared.isolatedHomePath)
      const cidfilePath = join(isolationRoot, 'container.cid')
      const launchArguments = prepared.arguments.filter((argument) => argument !== '--tty')
      launchArguments[launchArguments.length - 1] = 'sleep 300'
      const child = spawnProcess({
        program: prepared.executable,
        // The production Docker client is hosted by node-pty. This headless probe has no TTY,
        // so omit only the allocation flag while preserving the ownership and cleanup contract.
        args: launchArguments,
        env: prepared.hostEnv,
        stdio: 'ignore'
      })
      cid = await waitForCid(cidfilePath)
      await waitForContainerRunning(cid)
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited

      expect(
        runProcessSync({
          program: WORKER_AUTHORITY_DOCKER_PATH,
          args: ['inspect', '--format', '{{.State.Status}}', cid],
          timeoutMs: 5_000
        }).stdout.trim()
      ).toBe('running')
      await expect(
        recoverOrphanedWorkerAuthorityContainers({
          platform: 'darwin',
          tempRoot,
          probeOwner: async () => 'present'
        })
      ).resolves.toEqual({ removedContainers: 0, removedRoots: 0, rejectedRoots: 1 })
      expect(existsSync(isolationRoot)).toBe(true)

      await expect(
        recoverOrphanedWorkerAuthorityContainers({
          platform: 'darwin',
          tempRoot,
          probeOwner: async () => 'gone'
        })
      ).resolves.toEqual({
        removedContainers: 1,
        removedRoots: 1,
        rejectedRoots: 0
      })
      expect(existsSync(isolationRoot)).toBe(false)
    } finally {
      if (/^[0-9a-f]{64}$/.test(cid)) {
        runProcessSync({
          program: WORKER_AUTHORITY_DOCKER_PATH,
          args: ['rm', '--force', cid],
          timeoutMs: 5_000,
          maxOutputBytes: 1024
        })
      }
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 20_000)
})
