import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess, runProcessSync } from '../../shared/child-process/run-process'
import {
  NO_GITHUB_AUTHORITY_POLICY,
  NO_GITHUB_AUTHORITY_POLICY_DIGEST
} from '../../shared/worker-authority-policy'
import {
  prepareWorkerAuthorityIsolation,
  WORKER_AUTHORITY_IMAGE
} from './worker-authority-isolation'

const LIVE_DOCKER = process.env.ORCA_LIVE_WORKER_AUTHORITY_DOCKER === '1'

describe.skipIf(!LIVE_DOCKER)('worker authority live linked-worktree boundary', () => {
  it('keeps Git metadata read-only and masks remotes while Git inspection still works', async () => {
    const tempRoot = mkdtempSync('/private/tmp/orca-authority-git-live-')
    const workspacePath = join(tempRoot, 'linked-worktree')
    const codexHome = join(tempRoot, 'worker-codex')
    const lifecycleDirectory = join(tempRoot, 'lifecycle')
    mkdirSync(codexHome)
    mkdirSync(lifecycleDirectory)
    writeFileSync(join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"synthetic-worker"}\n', {
      mode: 0o600
    })
    const added = runProcessSync({
      program: 'git',
      args: ['worktree', 'add', '--detach', workspacePath, 'HEAD'],
      cwd: process.cwd(),
      timeoutMs: 10_000
    })
    if (added.code !== 0) {
      rmSync(tempRoot, { recursive: true, force: true })
      throw new Error(added.stderr)
    }

    const runIsolated = async (command: string) => {
      const prepared = prepareWorkerAuthorityIsolation({
        request: {
          schemaVersion: 'worker_authority_launch/1',
          policy: NO_GITHUB_AUTHORITY_POLICY,
          policyDigest: NO_GITHUB_AUTHORITY_POLICY_DIGEST,
          capabilityRef: `sha256:${'1'.repeat(64)}`,
          dispatchId: 'dispatch_linked_git_probe',
          worktreeId: 'worktree_linked_git_probe',
          setupPolicy: 'skip',
          imageDigest: WORKER_AUTHORITY_IMAGE,
          lifecycleDirectory,
          lifecycleBinding: `sha256:${'2'.repeat(64)}`
        },
        owner: {
          schemaVersion: 'worker_authority_daemon_owner/1',
          pid: process.pid,
          startedAtMs: Date.now() - process.uptime() * 1000,
          launchNonce: 'live-git-boundary',
          socketPath: join(tempRoot, 'daemon.sock'),
          tokenPath: join(tempRoot, 'daemon.token')
        },
        agent: 'codex',
        env: {
          HOME: process.env.HOME ?? tempRoot,
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          ORCA_WORKER_CODEX_HOME: codexHome
        },
        authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: codexHome },
        workspacePath,
        command: 'codex',
        platform: 'darwin',
        hostHome: tempRoot,
        tempRoot
      })
      const launchArguments = prepared.arguments.filter((argument) => argument !== '--tty')
      launchArguments[launchArguments.length - 1] = command
      let forceContainerRemoval = true
      try {
        const result = await runProcess({
          program: prepared.executable,
          args: launchArguments,
          env: prepared.hostEnv,
          timeoutMs: 10_000,
          maxOutputBytes: 16 * 1024
        })
        forceContainerRemoval = result.timedOut || result.signal !== null
        return result
      } finally {
        await prepared.cleanup(forceContainerRemoval)
      }
    }

    try {
      const status = await runIsolated('git status --porcelain=v1')
      expect(status.code).toBe(0)
      expect(status.stdout).toBe('')

      const remotes = await runIsolated('git remote')
      expect(remotes.code).toBe(0)
      expect(remotes.stdout).toBe('')

      const mutation = await runIsolated('git config --local probe.value blocked')
      expect(mutation.code).not.toBe(0)
    } finally {
      runProcessSync({
        program: 'git',
        args: ['worktree', 'remove', '--force', workspacePath],
        cwd: process.cwd(),
        timeoutMs: 10_000
      })
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
