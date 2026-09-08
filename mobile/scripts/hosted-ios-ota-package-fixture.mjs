import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  MobileWebManifestSchema,
  serializeMobileWebManifestForBuildId
} from '../../src/shared/mobile-web/manifest-contract.ts'

export async function createHostedIosOtaPackageFixture({ sourceRoot, runtimeDirectory }) {
  const root = path.join(runtimeDirectory, `ota-packages-${randomUUID()}`)
  const source = MobileWebManifestSchema.parse(
    JSON.parse(await readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'))
  )
  if (sha256(serializeMobileWebManifestForBuildId(source)) !== source.buildId) {
    throw new Error('OTA source manifest identity is invalid')
  }
  const bytesByPath = new Map()
  for (const asset of source.assets) {
    const bytes = await readFile(path.join(sourceRoot, asset.path))
    if (bytes.length !== asset.byteLength || sha256(bytes) !== asset.sha256) {
      throw new Error(`OTA source asset is invalid: ${asset.path}`)
    }
    bytesByPath.set(asset.path, bytes)
  }
  const generations = {}
  for (const label of ['A', 'B']) {
    const marker = `Orca OTA ${label} ${path.basename(root)}`
    const original = bytesByPath.get(source.entrypoint).toString('utf8')
    if ([...original.matchAll(/<title>[^<]*<\/title>/g)].length !== 1) {
      throw new Error('OTA source must contain exactly one document title')
    }
    const document = Buffer.from(
      original.replace(
        /<title>[^<]*<\/title>/,
        `<title>${marker}</title><meta name="orca-ota-generation" content="${marker}">`
      )
    )
    const assets = source.assets.map((asset) =>
      asset.path === source.entrypoint
        ? { ...asset, byteLength: document.length, sha256: sha256(document) }
        : asset
    )
    const seed = {
      ...source,
      assets,
      totalBytes: assets.reduce((sum, asset) => sum + asset.byteLength, 0)
    }
    const manifest = MobileWebManifestSchema.parse({
      ...seed,
      buildId: sha256(serializeMobileWebManifestForBuildId(seed))
    })
    const directory = path.join(root, label)
    for (const asset of assets) {
      const filename = path.join(directory, asset.path)
      await mkdir(path.dirname(filename), { recursive: true })
      await writeFile(
        filename,
        asset.path === source.entrypoint ? document : bytesByPath.get(asset.path)
      )
    }
    await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    generations[label] = { directory, marker, buildId: manifest.buildId }
  }
  const servedPackagePath = path.join(root, 'served')
  await symlink(generations.A.directory, servedPackagePath, 'dir')
  return { root, servedPackagePath, sourceBuildId: source.buildId, ...generations }
}

export async function serveHostedIosOtaGeneration(fixture, label) {
  if (label !== 'A' && label !== 'B') {
    throw new Error('Unknown OTA generation')
  }
  const next = path.join(fixture.root, `next-${randomUUID()}`)
  await symlink(fixture[label].directory, next, 'dir')
  await rename(next, fixture.servedPackagePath)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
