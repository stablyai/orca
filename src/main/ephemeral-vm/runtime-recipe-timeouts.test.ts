import '../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { getEphemeralVmRuntimeStorePath } from '../../shared/ephemeral-vm-runtime-store'
import { RollbackEphemeralVmRuntimeStoreSchema } from '../../shared/ephemeral-vm-runtimes'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import type { Store } from '../persistence/loading-store/store'
import { provisionEphemeralVmRuntime } from './runtime-service'
import { getRuntimeRecipeContext } from '../ipc/ephemeral-vm-recipe-context'

const hooks = vi.hoisted(() => {
  const recipes: OrcaVmRecipe[] = []
  return { recipes }
})
vi.mock('../workspace-hooks/hooks', () => ({
  loadHooks: () => ({ scripts: {}, environmentRecipes: hooks.recipes })
}))

const tempDirs: string[] = []
afterEach(async () => {
  await removeTempDirs(tempDirs.splice(0))
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('recipe timeoutSeconds and persisted runtimes', () => {
  it('persists a runtime whose recipe sets timeoutSeconds in a shape older builds still read', async () => {
    const userDataPath = makeDir('orca-vm-timeouts-user-data-')
    const repoPath = makeDir('orca-vm-timeouts-repo-')
    const startPath = join(repoPath, 'start.js')
    const pairingCode = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'wss://sandbox.example.com',
      deviceToken: 'token',
      publicKeyB64: 'public-key'
    })
    writeFileSync(
      startPath,
      `console.log(JSON.stringify({ schemaVersion: 1, pairingCode: ${JSON.stringify(pairingCode)}, projectRoot: '/workspace/repo' }))\n`
    )
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: `"${process.execPath}" "${startPath}"`,
      destroy: './destroy.sh',
      timeoutSeconds: { create: 1_800, destroy: 120 }
    }

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      repoId: 'repo-1',
      now: 1_000
    })

    expect(provisioned.ok).toBe(true)
    if (!provisioned.ok) {
      return
    }
    expect(provisioned.runtime.recipe).not.toHaveProperty('timeoutSeconds')
    // The strict recipe schema is shared with older builds, so the file must parse without the new field.
    const onDisk = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.safeParse(onDisk).success).toBe(true)

    // Later lifecycle calls take the repo's current limit on top of the snapshotted commands.
    hooks.recipes = [
      { ...recipe, destroy: './changed-destroy.sh', timeoutSeconds: { destroy: 60 } }
    ]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getRuntimeRecipeContext only reads getRepo from the store.
    const store = {
      getRepo: () => ({ id: 'repo-1', path: repoPath, kind: 'git' })
    } as unknown as Store
    const context = getRuntimeRecipeContext(store, userDataPath, provisioned.runtime.id)
    expect(context.recipe).toMatchObject({
      destroy: './destroy.sh',
      timeoutSeconds: { destroy: 60 }
    })

    // A different recipe that later took the same id does not impose its limits.
    hooks.recipes = [{ ...recipe, create: './other-create.sh', timeoutSeconds: { destroy: 5 } }]
    expect(
      getRuntimeRecipeContext(store, userDataPath, provisioned.runtime.id).recipe
    ).not.toHaveProperty('timeoutSeconds')

    hooks.recipes = []
    expect(
      getRuntimeRecipeContext(store, userDataPath, provisioned.runtime.id).recipe
    ).not.toHaveProperty('timeoutSeconds')
  })

  it('keeps passEnv out of the persisted snapshot and re-applies it for lifecycle steps', async () => {
    const userDataPath = makeDir('orca-vm-passenv-user-data-')
    const repoPath = makeDir('orca-vm-passenv-repo-')
    const startPath = join(repoPath, 'start.js')
    const pairingCode = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'wss://vm.example.com',
      deviceToken: 'token',
      publicKeyB64: 'public-key'
    })
    writeFileSync(
      startPath,
      `console.log(JSON.stringify({ schemaVersion: 1, pairingCode: ${JSON.stringify(pairingCode)}, projectRoot: '/workspace/repo' }))\n`
    )
    const recipe: OrcaVmRecipe = {
      id: 'remote-vm',
      name: 'Remote VM',
      create: `"${process.execPath}" "${startPath}"`,
      destroy: './destroy.sh',
      passEnv: ['GH_TOKEN']
    }

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      repoId: 'repo-1',
      now: 1_000
    })

    expect(provisioned.ok).toBe(true)
    if (!provisioned.ok) {
      return
    }
    expect(provisioned.runtime.recipe).not.toHaveProperty('passEnv')
    const onDisk = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.safeParse(onDisk).success).toBe(true)

    hooks.recipes = [recipe]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getRuntimeRecipeContext only reads getRepo from the store.
    const store = {
      getRepo: () => ({ id: 'repo-1', path: repoPath, kind: 'git' })
    } as unknown as Store
    expect(
      getRuntimeRecipeContext(store, userDataPath, provisioned.runtime.id).recipe
    ).toMatchObject({ passEnv: ['GH_TOKEN'] })

    // A different recipe that later took the same id does not change the environment.
    hooks.recipes = [{ ...recipe, create: './other-create.sh', passEnv: ['OTHER'] }]
    expect(
      getRuntimeRecipeContext(store, userDataPath, provisioned.runtime.id).recipe
    ).not.toHaveProperty('passEnv')
  })
})
