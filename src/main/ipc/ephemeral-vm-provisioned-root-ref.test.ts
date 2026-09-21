import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: never) => unknown>()
const { connectRuntimeOwnedSshTargetMock, getPathMock, handleMock, removeHandlerMock } = vi.hoisted(
  () => ({
    connectRuntimeOwnedSshTargetMock: vi.fn(),
    getPathMock: vi.fn(),
    handleMock: vi.fn(),
    removeHandlerMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: connectRuntimeOwnedSshTargetMock,
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: vi.fn()
}))

import { registerEphemeralVmHandlers } from './ephemeral-vm'

let userDataPath: string
let repoPath: string

beforeEach(() => {
  handlers.clear()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-ref-user-data-'))
  repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-ref-repo-'))
  getPathMock.mockReturnValue(userDataPath)
  handleMock.mockImplementation((channel: string, handler: never) => handlers.set(channel, handler))
  connectRuntimeOwnedSshTargetMock.mockResolvedValue({
    targetId: 'runtime-ssh-ref-test',
    target: { id: 'runtime-ssh-ref-test' }
  })
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
  rmSync(repoPath, { recursive: true, force: true })
  vi.clearAllMocks()
})

it('captures the source ref commit before a provisioned-root recipe starts', async () => {
  createGitFixtureCommit(repoPath)
  const expectedRefHead = createBranchCommit(repoPath, 'selected')
  const createCountPath = join(repoPath, 'create-count.txt')
  const createEnvPath = join(repoPath, 'create-env.json')
  writeRecipe(repoPath, createCountPath, createEnvPath)
  registerEphemeralVmHandlers(makeStore(repoPath) as never)

  const result = await provision({ ref: 'selected' })

  expect(result).toMatchObject({ ok: true, connectionType: 'ssh', expectedRefHead })
  expect(readFileSync(createCountPath, 'utf8')).toBe('x')
  expect(JSON.parse(readFileSync(createEnvPath, 'utf8'))).toEqual({
    ref: 'selected',
    refHead: expectedRefHead,
    repoUrl: ''
  })
})

it('captures the effective default ref when no start ref is selected', async () => {
  const expectedRefHead = createGitFixtureCommit(repoPath)
  const createCountPath = join(repoPath, 'create-count.txt')
  const createEnvPath = join(repoPath, 'create-env.json')
  writeRecipe(repoPath, createCountPath, createEnvPath)
  registerEphemeralVmHandlers(makeStore(repoPath) as never)

  const result = await provision({})

  expect(result).toMatchObject({ ok: true, connectionType: 'ssh', expectedRefHead })
  expect(JSON.parse(readFileSync(createEnvPath, 'utf8'))).toEqual({
    ref: 'main',
    refHead: expectedRefHead,
    repoUrl: ''
  })
})

it('pairs a multi-remote base with its fetch URL and remote branch ref', async () => {
  createGitFixtureCommit(repoPath)
  const expectedRefHead = createBranchCommit(repoPath, 'upstream-source')
  const remoteUrl = 'https://example.com/acme/upstream.git'
  execFileSync('git', ['remote', 'add', 'upstream', remoteUrl], { cwd: repoPath })
  execFileSync('git', ['update-ref', 'refs/remotes/upstream/main', expectedRefHead], {
    cwd: repoPath
  })
  const createCountPath = join(repoPath, 'create-count.txt')
  const createEnvPath = join(repoPath, 'create-env.json')
  writeRecipe(repoPath, createCountPath, createEnvPath)
  registerEphemeralVmHandlers(makeStore(repoPath) as never)

  const result = await provision({ ref: 'upstream/main' })

  expect(result).toMatchObject({ ok: true, connectionType: 'ssh', expectedRefHead })
  expect(JSON.parse(readFileSync(createEnvPath, 'utf8'))).toEqual({
    ref: 'refs/heads/main',
    refHead: expectedRefHead,
    repoUrl: remoteUrl
  })
})

it('rejects an unresolved source ref before the recipe creates resources', async () => {
  createGitFixtureCommit(repoPath)
  const createCountPath = join(repoPath, 'create-count.txt')
  writeRecipe(repoPath, createCountPath)
  registerEphemeralVmHandlers(makeStore(repoPath) as never)

  const result = await provision({ ref: 'refs/heads/missing' })

  expect(result).toMatchObject({
    ok: false,
    error: 'Could not resolve provisioned-root start ref: refs/heads/missing'
  })
  expect(() => readFileSync(createCountPath, 'utf8')).toThrow()
})

function provision(args: { ref?: string }): Promise<unknown> {
  return handlers.get('ephemeralVm:provision')?.(null, {
    repoId: 'repo-1',
    recipeId: 'cloud-sandbox',
    branch: 'fix-sandbox',
    ...(args.ref ? { ref: args.ref } : {})
  } as never) as Promise<unknown>
}

function makeStore(path: string) {
  const repo = { id: 'repo-1', path, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }
  return {
    getRepo: vi.fn((id: string) => (id === repo.id ? repo : null)),
    getRepos: vi.fn(() => [repo]),
    getSettings: vi.fn(() => ({ activeRuntimeEnvironmentId: null }))
  }
}

function createGitFixtureCommit(path: string): string {
  execFileSync('git', ['init'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: path })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: path })
  execFileSync('git', ['branch', '-M', 'main'], { cwd: path })
  writeFileSync(join(path, 'fixture.txt'), 'fixture')
  execFileSync('git', ['add', 'fixture.txt'], { cwd: path })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: path })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim()
}

function createBranchCommit(path: string, branch: string): string {
  execFileSync('git', ['checkout', '-b', branch], { cwd: path })
  writeFileSync(join(path, 'fixture.txt'), branch)
  execFileSync('git', ['add', 'fixture.txt'], { cwd: path })
  execFileSync('git', ['commit', '-m', branch], { cwd: path })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path,
    encoding: 'utf8'
  }).trim()
  execFileSync('git', ['checkout', 'main'], { cwd: path })
  return head
}

function writeRecipe(path: string, createCountPath: string, createEnvPath?: string): void {
  const startPath = join(path, 'start.js')
  writeFileSync(
    startPath,
    [
      `require('node:fs').appendFileSync(${JSON.stringify(createCountPath)}, 'x')`,
      ...(createEnvPath
        ? [
            `require('node:fs').writeFileSync(${JSON.stringify(createEnvPath)}, JSON.stringify({ref:process.env.ORCA_REPO_REF,refHead:process.env.ORCA_REPO_REF_HEAD,repoUrl:process.env.ORCA_REPO_URL}))`
          ]
        : []),
      'console.log(JSON.stringify({schemaVersion:2,checkoutMode:"provisioned-root",',
      'connection:{type:"ssh",projectRoot:"/workspace/repo",',
      'target:{label:"Sandbox",host:"host",port:22,username:"root"}}}))'
    ].join('\n')
  )
  writeFileSync(
    join(path, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Cloud Sandbox',
      '    checkoutMode: provisioned-root',
      `    create: ${JSON.stringify(`"${process.execPath}" "${startPath}"`)}`,
      '    destroy: none'
    ].join('\n')
  )
}
