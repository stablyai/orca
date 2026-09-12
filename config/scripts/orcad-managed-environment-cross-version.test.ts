import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.ORCAD_ROLLBACK_USER_DATA_PATH },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf8').slice('encrypted:'.length)
  }
}))

const targetRoot = process.env.ORCAD_ROLLBACK_TARGET_ROOT
const operation = process.env.ORCAD_ROLLBACK_OPERATION
const phase = process.env.ORCAD_ROLLBACK_PHASE
const userDataPath = process.env.ORCAD_ROLLBACK_USER_DATA_PATH
const environmentId = 'managed-environment'
const sshTargetId = 'ssh-prod'
const targetGeneration = 7
const localPort = 46_768
const remotePort = 6_768

type CrossVersionManifest = {
  migrationId: string
  manifestSha256: string
  source: { sshTargetId: string; sshTargetGeneration: number; targetLabel: string }
}

test.skipIf(!targetRoot || !operation || !phase || !userDataPath)(
  `managed orcad rollback ${phase ?? 'disabled'} ${operation ?? 'disabled'}`,
  async () => {
    if (!targetRoot || !operation || !phase || !userDataPath) {
      throw new Error(
        'ORCAD_ROLLBACK_TARGET_ROOT, OPERATION, PHASE, and USER_DATA_PATH are required'
      )
    }
    mkdirSync(userDataPath, { recursive: true })
    const environmentStore = await importTarget('src/shared/runtime-environment-store.ts')
    if (operation === 'write-current') {
      const pairing = await importTarget('src/shared/pairing.ts')
      environmentStore.addEnvironmentFromPairingCode(userDataPath, {
        id: environmentId,
        name: 'Managed server',
        pairingCode: pairing.encodePairingOffer({
          v: 2,
          endpoint: `ws://127.0.0.1:${localPort}`,
          deviceToken: 'device-token',
          publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
          pairedDeviceId: 'paired-device'
        }),
        connectionDependency: 'ssh-tunnel',
        orcadDeployment: deploymentLink(),
        now: 1_000
      })
      await writeProfile()
      return
    }
    if (operation === 'rewrite-with-origin-main') {
      const rawBefore = readJson<{ environments: Record<string, unknown>[] }>(
        environmentStore.getEnvironmentStorePath(userDataPath)
      )
      expect(rawBefore.environments[0].orcadDeployment).toEqual(deploymentLink())
      environmentStore.markEnvironmentUsed(userDataPath, environmentId, {
        runtimeId: 'runtime-after-downgrade',
        now: 2_000
      })
      const rawAfter = readJson<{ environments: Record<string, unknown>[] }>(
        environmentStore.getEnvironmentStorePath(userDataPath)
      )
      expect(rawAfter.environments[0]).not.toHaveProperty('orcadDeployment')
      expect(rawAfter.environments[0].connectionDependency).toBe('ssh-tunnel')
      await rewriteProfileThroughStore()
      return
    }
    if (operation === 'repair-after-reupgrade') {
      const before = environmentStore.listEnvironments(userDataPath)[0]
      expect(before).not.toHaveProperty('orcadDeployment')
      const restored = environmentStore.restoreManagedOrcadEnvironmentLink(
        userDataPath,
        environmentId,
        {
          sshTargetId,
          sshTargetGeneration: targetGeneration,
          remotePort
        }
      )
      expect(restored).toEqual({ ...before, orcadDeployment: deploymentLink() })
      await verifyProfileThroughStore()
      return
    }
    throw new Error(`Unknown operation: ${operation}`)
  }
)

async function writeProfile(): Promise<void> {
  const digest = await importTarget('src/main/orcad/orcad-migration-manifest-digest.ts')
  const unsignedManifest = {
    version: 1,
    migrationId: 'migration-1',
    createdAt: '2026-08-30T00:00:00.000Z',
    source: {
      sshTargetId,
      sshTargetGeneration: targetGeneration,
      targetLabel: 'Production'
    },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] }
  }
  const manifest = {
    ...unsignedManifest,
    manifestSha256: digest.computeOrcadMigrationManifestSha256(unsignedManifest)
  }
  writeFileSync(
    profilePath(),
    JSON.stringify({
      sshTargets: [sshTarget()],
      orcadMigrationSourceCutovers: [cutoverForPhase(manifest)]
    }),
    'utf8'
  )
}

async function rewriteProfileThroughStore(): Promise<void> {
  const persistence = await importTarget('src/main/persistence.ts')
  const store = new persistence.Store({ dataFile: profilePath() })
  expect(store.getSshTarget(sshTargetId)).toMatchObject(sshTarget())
  store.updateSshTarget(sshTargetId, { lastRequiredPassphrase: true })
  await store.flushPendingOrThrowAsync()
  store.freezeWrites()
  const persisted = readJson<{
    sshTargets: Record<string, unknown>[]
    orcadMigrationSourceCutovers: Record<string, unknown>[]
  }>(profilePath())
  expect(persisted.sshTargets[0]).toMatchObject(sshTarget())
  expect(persisted.orcadMigrationSourceCutovers[0]).toMatchObject({
    destinationEnvironmentId: environmentId,
    phase
  })
}

async function verifyProfileThroughStore(): Promise<void> {
  const persistence = await importTarget('src/main/persistence.ts')
  const store = new persistence.Store({ dataFile: profilePath() })
  expect(store.getSshTarget(sshTargetId)).toMatchObject({
    ...sshTarget(),
    lastRequiredPassphrase: true
  })
  expect(store.listOrcadMigrationSourceCutovers()).toEqual([
    expect.objectContaining({
      destinationEnvironmentId: environmentId,
      phase
    })
  ])
  store.freezeWrites()
}

function cutoverForPhase(manifest: CrossVersionManifest) {
  const base = {
    version: 1,
    phase,
    destinationEnvironmentId: environmentId,
    destinationName: 'Managed server',
    manifest,
    startedAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:01:00.000Z'
  }
  if (phase === 'destination-staged') {
    return { ...base, stagedAt: '2026-08-30T00:01:00.000Z' }
  }
  if (phase === 'destination-committed' || phase === 'source-retired') {
    const receipt = {
      version: 1,
      migrationId: manifest.migrationId,
      manifestSha256: manifest.manifestSha256,
      source: manifest.source,
      importedAt: '2026-08-30T00:01:00.000Z',
      repositoryIds: [],
      projectGroupIds: [],
      folderWorkspaceIds: []
    }
    return {
      ...base,
      receipt,
      ...(phase === 'source-retired' ? { retiredAt: '2026-08-30T00:02:00.000Z' } : {})
    }
  }
  return base
}

function deploymentLink() {
  return { sshTargetId, sshTargetGeneration: targetGeneration, localPort, remotePort }
}

function sshTarget() {
  return {
    id: sshTargetId,
    label: 'Production',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    generation: targetGeneration,
    owner: { type: 'on-demand-runtime', runtimeId: `managed-orcad:${environmentId}` }
  }
}

async function importTarget(relativePath: string) {
  return import(/* @vite-ignore */ pathToFileURL(resolve(targetRoot!, relativePath)).href)
}

function profilePath(): string {
  return join(userDataPath!, 'profile.json')
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
