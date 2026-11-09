import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import type { PluginService } from '../plugins/plugin-service'
import type { Store } from '../persistence/loading-store/store'
import { listWorkspaceProviders, resolveWorkspaceProviderRecipe } from './workspace-providers'

let root: string
let repo: Repo

function plugins(entries: { pluginKey: string; recipe: OrcaVmRecipe }[]): PluginService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provider lookup reads only whenReady and the approved recipe registry.
  return {
    whenReady: async () => {},
    contentPacks: { vmRecipes: { list: () => entries } }
  } as unknown as PluginService
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-providers-'))
  mkdirSync(join(root, 'repo'))
  writeFileSync(
    join(root, 'repo', 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: dev-vm',
      '    name: Dev VM',
      '    create: ./create.sh',
      '    destroy: ./destroy.sh',
      '  - id: shared',
      '    name: Shared',
      '    create: ./create.sh',
      ''
    ].join('\n')
  )
  repo = {
    id: 'repo-1',
    path: join(root, 'repo'),
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const pluginRecipe = (id: string): OrcaVmRecipe => ({ id, name: `Plugin ${id}`, create: './p.sh' })

describe('workspace provider resolution', () => {
  it('resolves an orca.yaml recipe and a plugin recipe by their own namespaces', async () => {
    const service = plugins([{ pluginKey: 'acme', recipe: pluginRecipe('gpu-box') }])
    await expect(
      resolveWorkspaceProviderRecipe(repo, { kind: 'recipe', id: 'dev-vm' }, service)
    ).resolves.toMatchObject({ id: 'dev-vm', destroy: './destroy.sh' })
    await expect(
      resolveWorkspaceProviderRecipe(
        repo,
        { kind: 'plugin', pluginKey: 'acme', id: 'gpu-box' },
        service
      )
    ).resolves.toMatchObject({ name: 'Plugin gpu-box' })
    // A plugin recipe is never reachable as recipe:<id>, and vice versa.
    await expect(
      resolveWorkspaceProviderRecipe(repo, { kind: 'recipe', id: 'gpu-box' }, service)
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      data: { valid: expect.arrayContaining(['recipe:dev-vm', 'plugin:acme/gpu-box']) }
    })
  })

  it('refuses a plugin recipe that shares an id with the repo recipe its lifecycle would use', async () => {
    const service = plugins([{ pluginKey: 'acme', recipe: pluginRecipe('shared') }])
    await expect(
      resolveWorkspaceProviderRecipe(
        repo,
        { kind: 'plugin', pluginKey: 'acme', id: 'shared' },
        service
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('lists providers with a versioned, allow-listed shape', async () => {
    const service = plugins([
      { pluginKey: 'acme', recipe: pluginRecipe('gpu-box') },
      { pluginKey: 'acme', recipe: pluginRecipe('shared') }
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing reads repos only when no repo is passed.
    const store = { getRepos: () => [repo] } as unknown as Store
    const listed = await listWorkspaceProviders(store, null, service)
    expect(listed.schemaVersion).toBe(1)
    expect(listed.providers.map((provider) => [provider.target, provider.available])).toEqual([
      ['recipe:dev-vm', true],
      ['recipe:shared', true],
      ['plugin:acme/gpu-box', true],
      ['plugin:acme/shared', false]
    ])
    expect(listed.providers[0]).toEqual({
      target: 'recipe:dev-vm',
      kind: 'recipe',
      name: 'Dev VM',
      repo: { id: 'repo-1', name: 'Repo', path: repo.path },
      available: true,
      checkoutMode: 'orca-worktree',
      capabilities: { suspend: false, resume: false, destroy: true },
      sizes: [],
      inputs: []
    })
    expect(listed.providers[1]?.capabilities.destroy).toBe(false)
  })
})
