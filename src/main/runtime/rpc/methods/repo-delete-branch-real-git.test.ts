import '../unused-default-rpc-methods.test-fixture'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { partialRuntimeStore } from '../../orca-runtime-tests/runtime-store-partial-fixture'
import { OrcaRuntimeRpcServer } from '../server/runtime-rpc'
import { REPO_METHODS } from './repo'
import { STATUS_METHODS } from './status'
import { REPO_DELETE_BRANCH_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import type { Repo } from '../../../../shared/repo-types'
import { RuntimeClient } from '../../../../cli/runtime-client'
import { parseArgs, validateCommandAndFlags } from '../../../../cli/args'
import { dispatch } from '../../../../cli/dispatch'
import { CORE_COMMAND_SPECS } from '../../../../cli/specs/core'
import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

let root: string
let repo: Repo
let oid: string
let client: RuntimeClient
let server: OrcaRuntimeRpcServer

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: root })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_COUNT', undefined)
  vi.stubEnv('GIT_CONFIG_PARAMETERS', undefined)
  installRealWorkerThreadChildProcesses()
  root = await mkdtemp(join(tmpdir(), 'orca-branch-rpc-'))
  await git('init', '-q')
  await git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await git('config', 'user.name', 'Branch RPC test')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(root, 'file'), 'base\n')
  await git('add', 'file')
  await git('commit', '-qm', 'base')
  await git('branch', 'feature')
  oid = await git('rev-parse', 'HEAD')
  await git('remote', 'add', 'origin', 'https://example.test/team/project.git')
  await git('update-ref', 'refs/remotes/origin/main', oid)
  await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  repo = {
    id: 'branch-test',
    path: root,
    displayName: 'Branch test',
    badgeColor: '#fff',
    addedAt: 1
  }
  const store = partialRuntimeStore({
    getRepos: () => [repo],
    getRepo: (id) => (id === repo.id ? repo : undefined)
  })
  await mkdir(join(root, 'profile'), { recursive: true })
  server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(store),
    userDataPath: join(root, 'profile'),
    methods: [...STATUS_METHODS, ...REPO_METHODS]
  })
  await server.start()
  client = new RuntimeClient(join(root, 'profile'), 10_000, null, null)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await server?.stop()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function request() {
  return {
    repo: 'id:branch-test',
    repoHostId: 'local',
    ref: 'refs/heads/feature',
    expectedOid: oid,
    anchorRef: 'refs/remotes/origin/main',
    anchorOid: oid
  }
}

function command() {
  const parsed = parseArgs([
    'repo',
    'delete-branch',
    '--repo',
    'id:branch-test',
    '--repo-host-id',
    'local',
    '--ref',
    'refs/heads/feature',
    '--expected-oid',
    oid,
    '--anchor-ref',
    'refs/remotes/origin/main',
    '--anchor-oid',
    oid,
    '--json'
  ])
  validateCommandAndFlags(CORE_COMMAND_SPECS, parsed)
  return dispatch(parsed.commandPath, { flags: parsed.flags, client, cwd: root, json: true })
}

describe('standalone deletion CLI through a real isolated runtime socket', () => {
  it('advertises capability and deletes through command, RPC schema, routing and Git', async () => {
    const status = await client.call<{ capabilities: string[] }>('status.get')
    expect(status.result.capabilities).toContain(REPO_DELETE_BRANCH_RUNTIME_CAPABILITY)
    await command()
    const result = await runProcess({
      program: 'git',
      args: ['show-ref', '--verify', '--quiet', 'refs/heads/feature'],
      cwd: root
    })
    expect(result.code).toBe(1)
  })

  it.each([
    { change: { repoHostId: undefined } },
    { change: { repoHostId: 'ssh:elsewhere' } },
    { change: { repo: 'name:Branch test' } },
    { change: { force: true } }
  ])(
    'refuses incomplete or broadened identity at the wire boundary: $change',
    async ({ change }) => {
      await expect(
        client.call('repo.deleteBranch', { ...request(), ...change })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(await git('rev-parse', 'feature')).toBe(oid)
    }
  )

  it('refuses an unregistered exact repository identity', async () => {
    await expect(
      client.call('repo.deleteBranch', { ...request(), repo: 'id:missing' })
    ).rejects.toMatchObject({ code: 'branch_deletion_failed' })
    expect(await git('rev-parse', 'feature')).toBe(oid)
  })

  it('refuses folder targets without touching Git', async () => {
    repo.kind = 'folder'
    await expect(command()).rejects.toMatchObject({ code: 'branch_deletion_failed' })
    expect(await git('rev-parse', 'feature')).toBe(oid)
  })

  it('refuses a conflicting local/SSH host identity without local fallback', async () => {
    repo.executionHostId = 'local'
    repo.connectionId = 'elsewhere'
    await expect(command()).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(await git('rev-parse', 'feature')).toBe(oid)
  })

  it('reports stale OID refusal as a failed mutation', async () => {
    await expect(
      client.call('repo.deleteBranch', {
        ...request(),
        expectedOid: '1111111111111111111111111111111111111111'
      })
    ).rejects.toMatchObject({ code: 'branch_deletion_failed' })
    expect(await git('rev-parse', 'feature')).toBe(oid)
  })

  it('refuses old host capabilities before dispatching mutation', async () => {
    await server.stop()
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getRepos: () => [repo],
        getRepo: (id) => (id === repo.id ? repo : undefined)
      })
    )
    vi.spyOn(runtime, 'getStatus').mockReturnValue({ ...runtime.getStatus(), capabilities: [] })
    server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: join(root, 'profile'),
      methods: [...STATUS_METHODS, ...REPO_METHODS]
    })
    await server.start()
    await expect(command()).rejects.toMatchObject({ code: 'unsupported_operation' })
    expect(await git('rev-parse', 'feature')).toBe(oid)
  })
})
