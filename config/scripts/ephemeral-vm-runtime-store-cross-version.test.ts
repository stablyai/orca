import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'

const targetRoot = process.env.STA_4274_TARGET_ROOT
const operation = process.env.STA_4274_OPERATION
const ownedDirs: string[] = []

function makeOwnedDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  ownedDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const ordinary = {
  id: 'ordinary-runtime',
  recipeId: 'ordinary-recipe',
  recipe: {
    id: 'ordinary-recipe',
    name: 'Ordinary VM',
    create: './ordinary-create.sh',
    destroy: './ordinary-destroy.sh'
  },
  status: 'running' as const,
  cleanupStatus: 'not_started' as const,
  createdAt: 1_000,
  updatedAt: 1_000,
  recipeResult: {
    schemaVersion: 1 as const,
    connection: {
      type: 'ssh' as const,
      projectRoot: '/workspace/ordinary',
      target: {
        label: 'Ordinary VM',
        host: 'ordinary.example.com',
        port: 22,
        username: 'developer'
      }
    },
    userData: { resourceId: 'ordinary-resource' }
  }
}

const provisionedRoot = {
  id: 'provisioned-root-runtime',
  recipeId: 'provisioned-root-recipe',
  recipe: {
    id: 'provisioned-root-recipe',
    name: 'Provisioned Root VM',
    create: './provisioned-root-create.sh',
    destroy: './provisioned-root-destroy.sh',
    checkoutMode: 'provisioned-root' as const
  },
  status: 'running' as const,
  cleanupStatus: 'not_started' as const,
  createdAt: 2_000,
  updatedAt: 2_000,
  recipeResult: {
    schemaVersion: 2 as const,
    checkoutMode: 'provisioned-root' as const,
    connection: {
      type: 'ssh' as const,
      projectRoot: '/workspace/provisioned',
      target: {
        label: 'Provisioned Root VM',
        host: 'provisioned.example.com',
        port: 22,
        username: 'developer'
      }
    },
    userData: { resourceId: 'provisioned-resource' }
  }
}

test.skipIf(!targetRoot || !operation)(`STA-4274 ${operation ?? 'disabled'}`, async () => {
  if (!targetRoot || !operation) {
    throw new Error('STA_4274_TARGET_ROOT and STA_4274_OPERATION are required')
  }
  const userDataPath = process.env.STA_4274_USER_DATA_PATH ?? makeOwnedDir('sta-4274-')
  const moduleUrl = pathToFileURL(
    resolve(targetRoot, 'src/shared/ephemeral-vm-runtime-store.ts')
  ).href
  const store = await import(/* @vite-ignore */ moduleUrl)

  if (operation === 'write-legacy') {
    store.upsertEphemeralVmRuntime(userDataPath, ordinary)
    return
  }
  if (operation === 'write-mixed') {
    store.upsertEphemeralVmRuntime(userDataPath, ordinary)
    store.upsertEphemeralVmRuntime(userDataPath, provisionedRoot)
    return
  }
  if (operation === 'read') {
    const runtimes = store.listEphemeralVmRuntimes(userDataPath)
    expect(runtimes.map((record: { id: string }) => record.id)).toEqual([
      'provisioned-root-runtime',
      'ordinary-runtime'
    ])
    return
  }
  if (operation === 'read-rollback-projection') {
    const runtimes = store.listEphemeralVmRuntimes(userDataPath)
    expect(runtimes).toHaveLength(2)
    expect(runtimes[0].recipe).not.toHaveProperty('checkoutMode')
    expect(runtimes[0].recipeResult).toMatchObject({ schemaVersion: 1 })
    return
  }
  if (operation === 'mutate-lifecycle') {
    store.updateEphemeralVmRuntimeStatus(userDataPath, 'ordinary-runtime', {
      status: 'suspended',
      updatedAt: 3_000
    })
    const repoPath = makeOwnedDir('sta-4274-cleanup-')
    const cleanupPath = join(repoPath, 'cleanup.js')
    const proofPath = join(repoPath, 'cleanup-proof')
    writeFileSync(
      cleanupPath,
      [
        "let input = ''",
        "process.stdin.on('data', (chunk) => { input += chunk })",
        "process.stdin.on('end', () => {",
        '  const payload = JSON.parse(input)',
        '  if (payload.recipeResult.schemaVersion !== 1) process.exit(12)',
        "  if (payload.recipeResult.userData.resourceId !== 'provisioned-resource') process.exit(13)",
        `  require('fs').writeFileSync(${JSON.stringify(proofPath)}, 'destroyed')`,
        '})'
      ].join('\n')
    )
    const serviceUrl = pathToFileURL(
      resolve(targetRoot, 'src/main/ephemeral-vm-runtime-service.ts')
    ).href
    const service = await import(/* @vite-ignore */ serviceUrl)
    const result = await service.cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath,
      runtimeId: 'provisioned-root-runtime',
      recipe: {
        id: 'provisioned-root-recipe',
        name: 'Provisioned Root VM',
        create: './provisioned-root-create.sh',
        destroy: `${JSON.stringify(process.execPath)} ${JSON.stringify(cleanupPath)}`
      },
      now: 3_000
    })
    expect(result).toMatchObject({
      ok: true,
      runtime: { status: 'cleaned', cleanupStatus: 'succeeded' }
    })
    expect(existsSync(proofPath)).toBe(true)
    return
  }
  if (operation === 'read-after-downgrade') {
    expect(store.listEphemeralVmRuntimes(userDataPath)).toEqual([
      expect.objectContaining({
        id: 'provisioned-root-runtime',
        status: 'cleaned',
        cleanupStatus: 'succeeded',
        recipe: expect.objectContaining({ checkoutMode: 'provisioned-root' }),
        recipeResult: expect.objectContaining({
          schemaVersion: 2,
          checkoutMode: 'provisioned-root'
        })
      }),
      expect.objectContaining({ id: 'ordinary-runtime', status: 'suspended' })
    ])
    return
  }
  if (operation === 'read-legacy') {
    expect(
      store.listEphemeralVmRuntimes(userDataPath).map((record: { id: string }) => record.id)
    ).toEqual(['ordinary-runtime'])
    return
  }
  throw new Error(`Unknown operation: ${operation}`)
})
