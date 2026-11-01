import './unused-default-rpc-methods.test-fixture'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { getRuntimeMetadataPath } from '../../../shared/runtime-bootstrap'
import type { Repo } from '../../../shared/repo-types'
import { RuntimeRepositoryRegistrationController } from '../runtime-repository-registration-controller'
import { partialRuntimeStore } from '../runtime-store-partial-fixture'
import type { RpcRequest } from './core'
import { repoDispatcher } from './methods/repo-rpc.test-fixture'
import { UnixSocketTransport } from './unix-socket-transport'

vi.mock('../../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

const cliPath = '../../../cli/index'
const { main }: { main: (argv: string[], cwd: string) => Promise<void> } = await import(cliPath)
const repoReply = z.object({
  result: z.object({ repo: z.object({ id: z.string(), path: z.string(), kind: z.string() }) })
})

it('opens a repo-tool root through the CLI folder route and keeps subproject Git registration', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-repo-cli-')))
  const tree = join(root, 'repo tree')
  const project = join(tree, 'project')
  const repos: Repo[] = []
  const store = partialRuntimeStore({
    getRepos: () => repos,
    getRepo: (id) => repos.find((repo) => repo.id === id),
    addRepo: (repo) => repos.push(repo)
  })
  const controller = new RuntimeRepositoryRegistrationController({
    getStore: () => store,
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })
  const dispatcher = repoDispatcher({
    getRuntimeId: () => 'repo-cli-test',
    addRepo: (...args) => controller.add(...args),
    listVisibleRepos: () => repos,
    requireStore: () => store
  })
  const kind = process.platform === 'win32' ? 'named-pipe' : 'unix'
  const endpoint =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\orca-repo-cli-${randomUUID()}`
      : join(root, 'rpc.sock')
  const socket = new UnixSocketTransport({ kind, endpoint })
  const requests: RpcRequest[] = []
  socket.onMessage((message, reply) => {
    const request: RpcRequest = JSON.parse(message)
    requests.push(request)
    void dispatcher.dispatch(request).then((response) => reply(JSON.stringify(response)))
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const previousExitCode = process.exitCode
  const cli = async (args: string[]) => {
    log.mockClear()
    errors.mockClear()
    process.exitCode = 0
    await main([...args, '--json'], root)
    return JSON.parse([...log.mock.calls, ...errors.mock.calls].flat().join('\n'))
  }
  try {
    await mkdir(join(tree, '.repo', 'manifests'), { recursive: true })
    await mkdir(project)
    await writeFile(join(tree, '.repo', 'manifest.xml'), '<manifest/>')
    for (const path of [project, join(tree, '.repo', 'manifests')]) {
      const git = runProcessSync({ program: 'git', args: ['init', '-q', path] })
      expect(git.code, git.stderr).toBe(0)
    }
    await socket.start()
    await writeFile(
      getRuntimeMetadataPath(root),
      JSON.stringify({
        runtimeId: 'repo-cli-test',
        pid: process.pid,
        transports: [{ kind, endpoint }],
        authToken: 'test',
        startedAt: 1
      })
    )
    vi.stubEnv('ORCA_USER_DATA_PATH', root)
    vi.stubEnv('ORCA_PAIRING_CODE', '')
    vi.stubEnv('ORCA_REMOTE_PAIRING', '')
    vi.stubEnv('ORCA_ENVIRONMENT', '')

    const refusal = await cli(['repo', 'add', '--path', tree])
    expect(refusal).toMatchObject({
      ok: false,
      error: {
        message: `Not a valid git repository: ${tree}`,
        data: { nextSteps: [expect.stringContaining('--kind folder')] }
      }
    })
    expect(repos).toHaveLength(0)
    expect(requests.at(-1)?.params).toEqual({ path: tree })

    const command = ['repo', 'add', '--path', './repo tree', '--kind', 'folder']
    const first = repoReply.parse(await cli(command)).result.repo
    expect(first).toMatchObject({ path: tree, kind: 'folder' })
    const repeated = repoReply.parse(await cli(command)).result.repo
    expect(repeated.id).toBe(first.id)
    expect(repos).toHaveLength(1)
    expect(await cli(['repo', 'list'])).toMatchObject({ result: { repos: [first] } })

    const subproject = repoReply.parse(
      await cli(['repo', 'add', '--path', project, '--kind', 'git'])
    ).result.repo
    // Windows Git registration stores the resolved root with forward slashes.
    expect(normalizeRuntimePathForComparison(subproject.path)).toBe(
      normalizeRuntimePathForComparison(project)
    )
    expect(subproject.kind).toBe('git')
    expect(repos).toHaveLength(2)

    const beforeInvalid = requests.length
    expect(await cli(['repo', 'add', '--path', tree, '--kind', 'repo-tool'])).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(requests).toHaveLength(beforeInvalid)
    expect(repos).toHaveLength(2)
  } finally {
    await socket.stop()
    vi.unstubAllEnvs()
    process.exitCode = previousExitCode
    log.mockRestore()
    errors.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
