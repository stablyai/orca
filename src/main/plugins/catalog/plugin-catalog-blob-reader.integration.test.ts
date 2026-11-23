import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gitExecFileAsyncBuffer } from '../../git/command-runner/git-exec-file'
import * as gitRunner from '../../git/command-runner/git-exec-file'
import { PluginCatalogRepositoryStore } from './plugin-catalog-repository'
import { pngImageBytes } from '../media/plugin-image-test-fixture'
import { createCatalogBufferMemo } from './plugin-catalog-image-extraction'
import {
  loadCatalogFiles,
  readCatalogImageBlobs,
  type CatalogLoadState
} from './plugin-catalog-blob-reader'

let root: string
let repository: string
const runGit = gitExecFileAsyncBuffer

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-catalog-blobs-'))
  repository = join(root, 'catalog')
  await mkdir(repository)
  await git(['init', '--quiet'])
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32').each(['abort', 'timeout'])(
  'keeps repository ownership through delayed Git termination on %s',
  async (stop) => {
    const bytes = pngImageBytes(1600, 1000)
    const object = await writeBlob(bytes)
    const commit = await commitTree(`100644 blob ${object}\tcover.png\n`)
    const id = 'a'.repeat(32)
    const directory = join(root, 'catalog-repositories', id)
    const retained = join(directory, 'repository')
    await mkdir(directory, { recursive: true })
    await rename(repository, retained)
    const started = join(root, 'started')
    const stopping = join(root, 'stopping')
    const release = join(root, 'release')
    const shim = join(root, 'git.cjs')
    await writeFile(
      shim,
      `
      const fs = require('node:fs');
      process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(stopping)}, ''));
      setInterval(() => {
        if (fs.existsSync(${JSON.stringify(release)})) process.exit(1);
      }, 10);
      fs.writeFileSync(${JSON.stringify(started)}, '');
    `
    )
    await writeFile(
      join(root, 'git'),
      '#!/bin/sh\nexec "$ORCA_TEST_GIT_NODE" "$ORCA_TEST_GIT_SHIM" "$@"\n',
      { mode: 0o755 }
    )
    vi.stubEnv('ORCA_TEST_GIT_NODE', process.execPath)
    vi.stubEnv('ORCA_TEST_GIT_SHIM', shim)
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
    if (stop === 'timeout') {
      vi.spyOn(gitRunner, 'gitExecFileAsyncBuffer').mockImplementation((args, options) =>
        runGit(args, { ...options, timeout: 5_000 })
      )
    }
    const repositories = new PluginCatalogRepositoryStore(root)
    const controller = new AbortController()
    let completed = false
    const reading = repositories
      .readImages(
        id,
        () => ({
          commit,
          paths: new Map([['cover.png', 1024]]),
          slot: 'repository'
        }),
        controller.signal
      )
      .finally(() => {
        completed = true
      })
    const removing = repositories.remove(id)
    try {
      await vi.waitFor(() => access(started), { timeout: 10_000 })
      if (stop === 'abort') {
        controller.abort()
      }
      await vi.waitFor(() => access(stopping), { timeout: 10_000 })
      expect(completed).toBe(false)
      await expect(access(retained)).resolves.toBeUndefined()
    } finally {
      await writeFile(release, '')
      await removing
    }
    expect(await reading).toEqual(new Map())
    await expect(access(retained)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

async function git(args: string[], stdin?: string): Promise<string> {
  const { stdout } = await gitExecFileAsyncBuffer(args, { cwd: repository, timeout: 10_000, stdin })
  return stdout.toString().trim()
}

async function writeBlob(bytes: Buffer): Promise<string> {
  const file = join(repository, 'fixture.png')
  await writeFile(file, bytes)
  return git(['hash-object', '-w', '--', file])
}

async function commitTree(entries: string) {
  const tree = await git(['mktree'], entries)
  return git([
    '-c',
    'user.name=Catalog fixture',
    '-c',
    'user.email=catalog@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit-tree',
    tree,
    '-m',
    'Fixture images'
  ])
}

it('only reads regular image blobs, even when another Git mode points at the same bytes', async () => {
  const bytes = pngImageBytes(1600, 1000)
  const object = await writeBlob(bytes)
  const commit = await commitTree(
    `100644 blob ${object}\tcover.png\n120000 blob ${object}\tlink.png\n`
  )
  const images = await readCatalogImageBlobs(
    repository,
    commit,
    new Map([
      ['cover.png', 1024],
      ['link.png', 1024]
    ])
  )
  expect(images).toEqual(new Map([['cover.png', bytes]]))
})

it('rejects a non-portable requested path even if it contains valid image bytes', async () => {
  const object = await writeBlob(pngImageBytes(1600, 1000))
  const path = 'invalid:cover.png'
  const commit = await commitTree(`100644 blob ${object}\t${path}\n`)
  expect(await readCatalogImageBlobs(repository, commit, new Map([[path, 1024]]))).toEqual(
    new Map()
  )
})

it('lists requested paths literally even when they look like pathspec magic', async () => {
  const bytes = pngImageBytes(1600, 1000)
  const object = await writeBlob(bytes)
  const path = ':(literal)cover.png'
  const commit = await commitTree(`100644 blob ${object}\t${path}\n`)
  const state: CatalogLoadState = {
    files: new Map(),
    listed: new Map(),
    failed: new Set<string>(),
    memo: createCatalogBufferMemo()
  }
  await loadCatalogFiles(repository, commit, new Map([[path, 1024]]), state)
  expect(state.files.get(path)?.bytes).toEqual(bytes)
})

it('does not contact a promisor remote for a missing image blob', async () => {
  const object = await writeBlob(pngImageBytes(1600, 1000))
  const commit = await commitTree(`100644 blob ${object}\tcover.png\n`)
  await rm(join(repository, '.git', 'objects', object.slice(0, 2), object.slice(2)))
  await git(['config', 'remote.origin.url', 'ssh://git@example.invalid/catalog.git'])
  await git(['config', 'remote.origin.promisor', 'true'])
  const marker = join(root, 'remote-visited')
  const shim = join(root, 'remote.cjs')
  await writeFile(
    shim,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'visited')\nprocess.exitCode = 1\n`
  )
  vi.stubEnv(
    'GIT_SSH_COMMAND',
    `"${process.execPath.replaceAll('\\', '/')}" "${shim.replaceAll('\\', '/')}"`
  )
  vi.stubEnv('GIT_SSH_VARIANT', 'ssh')

  expect(await readCatalogImageBlobs(repository, commit, new Map([['cover.png', 1024]]))).toEqual(
    new Map()
  )
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('uses the catalog Git directory even when the inherited GIT_DIR points elsewhere', async () => {
  const bytes = pngImageBytes(1600, 1000)
  const object = await writeBlob(bytes)
  const commit = await commitTree(`100644 blob ${object}\tcover.png\n`)
  vi.stubEnv('GIT_DIR', join(root, 'elsewhere.git'))
  expect(await readCatalogImageBlobs(repository, commit, new Map([['cover.png', 1024]]))).toEqual(
    new Map([['cover.png', bytes]])
  )
})
