import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))
import {
  NO_GITHUB_AUTHORITY_POLICY,
  NO_GITHUB_AUTHORITY_POLICY_DIGEST
} from '../../shared/worker-authority-policy'
import {
  prepareWorkerAuthorityIsolation,
  verifyWorkerAuthorityContainerRuntime,
  WORKER_AUTHORITY_DOCKER_PATH,
  WORKER_AUTHORITY_IMAGE
} from './worker-authority-isolation'

describe('worker authority container isolation', () => {
  const roots: string[] = []

  afterEach(() => {
    runProcessMock.mockReset()
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function fixture() {
    const root = mkdtempSync('/private/tmp/orca-authority-test-')
    roots.push(root)
    const hostHome = join(root, 'host-home')
    const codexHome = join(hostHome, 'worker-codex')
    const workspacePath = join(root, 'repo')
    const lifecycleDirectory = join(root, 'lifecycle')
    const tempRoot = join(root, 'temp')
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(join(workspacePath, '.git'), { recursive: true })
    mkdirSync(lifecycleDirectory, { recursive: true })
    mkdirSync(tempRoot, { recursive: true })
    writeFileSync(
      join(workspacePath, '.git', 'config'),
      '[remote "origin"]\n  url = https://github.com/example/repo.git\n'
    )
    writeFileSync(join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"synthetic-worker"}\n', {
      mode: 0o600
    })
    const owner = {
      schemaVersion: 'worker_authority_daemon_owner/1',
      pid: 12345,
      startedAtMs: 1_700_000_000_000,
      launchNonce: 'synthetic-daemon',
      socketPath: join(root, 'daemon.sock'),
      tokenPath: join(root, 'daemon.token')
    } as const
    return { hostHome, codexHome, workspacePath, lifecycleDirectory, tempRoot, owner }
  }

  function request(lifecycleDirectory: string) {
    return {
      schemaVersion: 'worker_authority_launch/1',
      policy: NO_GITHUB_AUTHORITY_POLICY,
      policyDigest: NO_GITHUB_AUTHORITY_POLICY_DIGEST,
      capabilityRef: `sha256:${'1'.repeat(64)}`,
      dispatchId: 'dispatch_abc123',
      worktreeId: 'worktree_abc123',
      setupPolicy: 'skip',
      imageDigest: WORKER_AUTHORITY_IMAGE,
      lifecycleDirectory,
      lifecycleBinding: `sha256:${'2'.repeat(64)}`
    } as const
  }

  it('fails runtime preflight before Docker when the process owner has no dedicated credential', async () => {
    const previousWorkerCodexHome = process.env.ORCA_WORKER_CODEX_HOME
    delete process.env.ORCA_WORKER_CODEX_HOME
    try {
      await expect(verifyWorkerAuthorityContainerRuntime()).resolves.toBe(false)
      expect(runProcessMock).not.toHaveBeenCalled()
    } finally {
      if (previousWorkerCodexHome !== undefined) {
        process.env.ORCA_WORKER_CODEX_HOME = previousWorkerCodexHome
      }
    }
  })

  it('builds a pinned, least-privilege Docker launch and copies only Codex auth', () => {
    const f = fixture()
    const redirectedCodexHome = join(f.hostHome, 'terminal-selected-codex')
    mkdirSync(redirectedCodexHome)
    writeFileSync(join(redirectedCodexHome, 'auth.json'), '{"OPENAI_API_KEY":"founder"}\n', {
      mode: 0o600
    })
    const prepared = prepareWorkerAuthorityIsolation({
      request: request(f.lifecycleDirectory),
      owner: f.owner,
      agent: 'codex',
      env: {
        HOME: f.hostHome,
        PATH: '/usr/local/bin:/usr/bin:/bin',
        ORCA_WORKER_CODEX_HOME: redirectedCodexHome,
        GH_TOKEN: 'synthetic-github-secret',
        GITHUB_TOKEN: 'synthetic-github-secret',
        SSH_AUTH_SOCK: '/private/tmp/synthetic-agent.sock',
        GIT_ASKPASS: '/private/tmp/synthetic-askpass'
      },
      authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: f.codexHome },
      workspacePath: f.workspacePath,
      command: 'codex --no-alt-screen',
      platform: 'darwin',
      hostHome: f.hostHome,
      tempRoot: f.tempRoot
    })
    roots.push(prepared.isolatedHomePath)

    expect(prepared.executable).toBe(WORKER_AUTHORITY_DOCKER_PATH)
    expect(prepared.arguments).toContain(WORKER_AUTHORITY_IMAGE)
    expect(prepared.arguments).toEqual(
      expect.arrayContaining([
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=256'
      ])
    )
    const launch = prepared.arguments.join('\n')
    expect(launch).toContain(`src=${f.workspacePath},dst=${f.workspacePath}`)
    expect(launch).toContain(
      `src=${join(f.workspacePath, '.git')},dst=${join(f.workspacePath, '.git')},readonly`
    )
    expect(launch).toContain(`src=${f.lifecycleDirectory},dst=/orca-control`)
    expect(launch).not.toContain('docker.sock')
    expect(launch).not.toContain('orca.sock')
    expect(launch).not.toContain('synthetic-github-secret')
    expect(launch).not.toContain('synthetic-agent.sock')
    expect(launch).not.toContain('terminal-selected-codex')
    expect(launch).not.toContain('founder')
    expect(prepared.hostEnv).not.toHaveProperty('GH_TOKEN')
    expect(prepared.hostEnv).not.toHaveProperty('GITHUB_TOKEN')
    expect(prepared.hostEnv).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(readFileSync(join(prepared.isolatedHomePath, '.codex', 'auth.json'), 'utf8')).toBe(
      '{"OPENAI_API_KEY":"synthetic-worker"}\n'
    )
    expect(readFileSync(join(prepared.isolatedHomePath, '.codex', 'config.toml'), 'utf8')).toBe(
      `[projects.${JSON.stringify(f.workspacePath)}]\ntrust_level = "trusted"\n`
    )
    const configMount = prepared.arguments.find((argument) =>
      argument.endsWith(`dst=${join(f.workspacePath, '.git', 'config')},readonly`)
    )
    expect(configMount).toBeDefined()
    const sanitizedConfig = /src=([^,]+),dst=/.exec(configMount as string)?.[1]
    expect(readFileSync(sanitizedConfig as string, 'utf8')).toBe('')
  })

  it('refuses unsupported agents and an unpinned image before launch', () => {
    const f = fixture()
    expect(() =>
      prepareWorkerAuthorityIsolation({
        request: request(f.lifecycleDirectory),
        owner: f.owner,
        agent: 'claude',
        env: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        workspacePath: f.workspacePath,
        command: 'claude',
        platform: 'darwin',
        hostHome: f.hostHome,
        tempRoot: f.tempRoot
      })
    ).toThrow('worker_authority_policy_unsupported')
    expect(() =>
      prepareWorkerAuthorityIsolation({
        request: { ...request(f.lifecycleDirectory), imageDigest: 'orca-worker-authority:latest' },
        owner: f.owner,
        agent: 'codex',
        env: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        workspacePath: f.workspacePath,
        command: 'codex',
        platform: 'darwin',
        hostHome: f.hostHome,
        tempRoot: f.tempRoot
      })
    ).toThrow('worker_authority_policy_unsupported')
  })

  it('refuses a host command override that bypasses the pinned Codex executable', () => {
    const f = fixture()
    expect(() =>
      prepareWorkerAuthorityIsolation({
        request: request(f.lifecycleDirectory),
        owner: f.owner,
        agent: 'codex',
        env: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        workspacePath: f.workspacePath,
        command: '/opt/homebrew/bin/codex',
        platform: 'darwin',
        hostHome: f.hostHome,
        tempRoot: f.tempRoot
      })
    ).toThrow('worker_authority_isolation_failed')
  })

  it('never falls back to the founder Codex home for model authentication', () => {
    const f = fixture()
    expect(() =>
      prepareWorkerAuthorityIsolation({
        request: request(f.lifecycleDirectory),
        owner: f.owner,
        agent: 'codex',
        env: { CODEX_HOME: f.codexHome },
        authorityCredentialEnv: {},
        workspacePath: f.workspacePath,
        command: 'codex',
        platform: 'darwin',
        hostHome: f.hostHome,
        tempRoot: f.tempRoot
      })
    ).toThrow('worker_authority_isolation_failed')
  })

  it('refuses a credential file with no supported Codex authentication material', () => {
    const f = fixture()
    writeFileSync(join(f.codexHome, 'auth.json'), '{"provider":"synthetic"}\n')

    expect(() =>
      prepareWorkerAuthorityIsolation({
        request: request(f.lifecycleDirectory),
        owner: f.owner,
        agent: 'codex',
        env: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        workspacePath: f.workspacePath,
        command: 'codex',
        platform: 'darwin',
        hostHome: f.hostHome,
        tempRoot: f.tempRoot
      })
    ).toThrow('worker_authority_isolation_failed')
  })

  it('refuses an explicit redirect to the founder default Codex home', () => {
    const f = fixture()
    const founderCodexHome = join(f.hostHome, '.codex')
    mkdirSync(founderCodexHome)
    writeFileSync(join(founderCodexHome, 'auth.json'), '{"OPENAI_API_KEY":"founder"}\n', {
      mode: 0o600
    })

    expect(() =>
      prepareWorkerAuthorityIsolation({
        request: request(f.lifecycleDirectory),
        owner: f.owner,
        agent: 'codex',
        env: { ORCA_WORKER_CODEX_HOME: founderCodexHome },
        authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: founderCodexHome },
        workspacePath: f.workspacePath,
        command: 'codex',
        platform: 'darwin',
        hostHome: f.hostHome,
        tempRoot: f.tempRoot
      })
    ).toThrow('worker_authority_isolation_failed')
  })

  it('retains its ownership record when forced container removal is unconfirmed', async () => {
    const f = fixture()
    const prepared = prepareWorkerAuthorityIsolation({
      request: request(f.lifecycleDirectory),
      owner: f.owner,
      agent: 'codex',
      env: { ORCA_WORKER_CODEX_HOME: f.codexHome },
      authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: f.codexHome },
      workspacePath: f.workspacePath,
      command: 'codex',
      platform: 'darwin',
      hostHome: f.hostHome,
      tempRoot: f.tempRoot
    })
    const cidfileFlag = prepared.arguments.indexOf('--cidfile')
    const cidfilePath = prepared.arguments[cidfileFlag + 1]
    if (!cidfilePath) {
      throw new Error('missing private cidfile')
    }
    const cid = 'a'.repeat(64)
    writeFileSync(cidfilePath, cid, { flag: 'wx' })
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'already removed',
      timedOut: false
    })

    await prepared.cleanup()

    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: WORKER_AUTHORITY_DOCKER_PATH,
        args: ['rm', '--force', cid]
      })
    )
    expect(readFileSync(cidfilePath, 'utf8')).toBe(cid)
  })

  it('removes its ownership record after forced container removal succeeds', async () => {
    const f = fixture()
    const prepared = prepareWorkerAuthorityIsolation({
      request: request(f.lifecycleDirectory),
      owner: f.owner,
      agent: 'codex',
      env: { ORCA_WORKER_CODEX_HOME: f.codexHome },
      authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: f.codexHome },
      workspacePath: f.workspacePath,
      command: 'codex',
      platform: 'darwin',
      hostHome: f.hostHome,
      tempRoot: f.tempRoot
    })
    const cidfileFlag = prepared.arguments.indexOf('--cidfile')
    const cidfilePath = prepared.arguments[cidfileFlag + 1]
    if (!cidfilePath) {
      throw new Error('missing private cidfile')
    }
    writeFileSync(cidfilePath, 'a'.repeat(64), { flag: 'wx' })
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })

    await prepared.cleanup()

    expect(() => readFileSync(cidfilePath, 'utf8')).toThrow()
  })

  it('refuses credential-bearing repository remotes', () => {
    const f = fixture()
    writeFileSync(
      join(f.workspacePath, '.git', 'config'),
      '[remote "origin"]\n  url = https://token@example.com/repo.git\n'
    )
    expect(() =>
      prepareWorkerAuthorityIsolation({
        request: request(f.lifecycleDirectory),
        owner: f.owner,
        agent: 'codex',
        env: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        workspacePath: f.workspacePath,
        command: 'codex',
        platform: 'darwin',
        hostHome: f.hostHome,
        tempRoot: f.tempRoot
      })
    ).toThrow('worker_authority_isolation_failed')
  })

  it('classifies a workspace without Git metadata as unsupported isolation', () => {
    const f = fixture()
    rmSync(join(f.workspacePath, '.git'), { recursive: true })

    expect(() =>
      prepareWorkerAuthorityIsolation({
        request: request(f.lifecycleDirectory),
        owner: f.owner,
        agent: 'codex',
        env: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        authorityCredentialEnv: { ORCA_WORKER_CODEX_HOME: f.codexHome },
        workspacePath: f.workspacePath,
        command: 'codex',
        platform: 'darwin',
        hostHome: f.hostHome,
        tempRoot: f.tempRoot
      })
    ).toThrow('worker_authority_isolation_failed')
  })
})
