import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearServiceIdentityCacheForTests,
  resolveProjectRoot,
  resolveServiceIdentity,
  resolveServiceName
} from './service-project-identity'

let root: string

beforeEach(async () => {
  clearServiceIdentityCacheForTests()
  root = await mkdtemp(path.join(tmpdir(), 'orca-service-identity-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeFile(relativePath: string, contents = ''): Promise<string> {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf-8')
  return target
}

describe('resolveProjectRoot', () => {
  it('prefers the git root over a nested package manifest', async () => {
    await makeFile('mono-repo/.git/HEAD', 'ref: refs/heads/main')
    await makeFile('mono-repo/apps/market/package.json', '{"name":"market"}')

    const resolved = await resolveProjectRoot(path.join(root, 'mono-repo/apps/market'))

    expect(resolved).toBe(path.join(root, 'mono-repo'))
  })

  it('falls back to a build manifest when there is no git repo', async () => {
    await makeFile('plain-project/go.mod', 'module example.com/app')

    const resolved = await resolveProjectRoot(path.join(root, 'plain-project'))

    expect(resolved).toBe(path.join(root, 'plain-project'))
  })

  it('treats a worktree .git file as a root, not only a .git directory', async () => {
    await makeFile('worktree/.git', 'gitdir: /repo/.git/worktrees/feature')

    expect(await resolveProjectRoot(path.join(root, 'worktree'))).toBe(path.join(root, 'worktree'))
  })

  it('returns null when nothing marks a project', async () => {
    await mkdir(path.join(root, 'loose/dir'), { recursive: true })

    expect(await resolveProjectRoot(path.join(root, 'loose/dir'))).toBeNull()
  })
})

describe('resolveServiceName', () => {
  it('reads the name of the nearest package manifest', async () => {
    await makeFile('repo/.git/HEAD', '')
    await makeFile('repo/apps/market/package.json', '{"name":"market"}')

    const name = await resolveServiceName(
      path.join(root, 'repo/apps/market'),
      path.join(root, 'repo')
    )

    expect(name).toBe('market')
  })

  it('strips the scope from a scoped package name', async () => {
    await makeFile('repo/.git/HEAD', '')
    await makeFile('repo/apps/api/package.json', '{"name":"@numis/api"}')

    expect(
      await resolveServiceName(path.join(root, 'repo/apps/api'), path.join(root, 'repo'))
    ).toBe('api')
  })

  it('does not escape above the project root', async () => {
    await makeFile('outer/package.json', '{"name":"outer-should-not-win"}')
    await makeFile('outer/repo/.git/HEAD', '')
    await mkdir(path.join(root, 'outer/repo/src'), { recursive: true })

    const name = await resolveServiceName(
      path.join(root, 'outer/repo/src'),
      path.join(root, 'outer/repo')
    )

    expect(name).toBeNull()
  })

  it('returns null for a malformed package.json instead of throwing', async () => {
    await makeFile('repo/package.json', '{ not json')

    expect(await resolveServiceName(path.join(root, 'repo'), path.join(root, 'repo'))).toBeNull()
  })

  it('returns null when the manifest has no name field', async () => {
    await makeFile('repo/package.json', '{"private":true}')

    expect(await resolveServiceName(path.join(root, 'repo'), path.join(root, 'repo'))).toBeNull()
  })
})

describe('resolveServiceIdentity', () => {
  it('reports the monorepo as the project and the app as the service', async () => {
    await makeFile('mono-numis-store/.git/HEAD', '')
    await makeFile('mono-numis-store/package.json', '{"name":"mono-numis-store"}')
    await makeFile('mono-numis-store/apps/market/package.json', '{"name":"market"}')

    const identity = await resolveServiceIdentity(path.join(root, 'mono-numis-store/apps/market'))

    expect(identity.projectName).toBe('mono-numis-store')
    expect(identity.serviceName).toBe('market')
    expect(identity.projectRoot).toBe(path.join(root, 'mono-numis-store'))
  })

  it('returns nulls for a root-owned process whose cwd is /', async () => {
    expect(await resolveServiceIdentity('/')).toEqual({
      projectRoot: null,
      projectName: null,
      serviceName: null
    })
  })

  it('returns nulls for a missing cwd rather than throwing', async () => {
    expect(await resolveServiceIdentity(undefined)).toEqual({
      projectRoot: null,
      projectName: null,
      serviceName: null
    })
  })

  it('returns nulls for a directory that does not exist', async () => {
    const identity = await resolveServiceIdentity(path.join(root, 'gone/missing'))

    expect(identity.projectName).toBeNull()
    expect(identity.serviceName).toBeNull()
  })

  it('serves a repeated lookup from cache within the TTL', async () => {
    await makeFile('repo/.git/HEAD', '')
    await makeFile('repo/package.json', '{"name":"repo"}')
    const target = path.join(root, 'repo')

    const first = await resolveServiceIdentity(target)
    // Why not remove .git: package.json is itself a root manifest, so the walk
    // would still resolve the same identity and the assertion would hold even
    // on a cache miss. Renaming the package is the only edit a re-walk shows.
    await makeFile('repo/package.json', '{"name":"changed"}')
    const second = await resolveServiceIdentity(target)

    expect(second).toEqual(first)
  })
})
