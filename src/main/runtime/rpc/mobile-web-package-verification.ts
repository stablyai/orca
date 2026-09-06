import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  MobileWebManifestSchema,
  serializeMobileWebManifestForBuildId,
  type MobileWebAsset,
  type MobileWebManifest
} from '../../../shared/mobile-web/manifest-contract'

export type VerifiedMobileWebPackage = {
  root: string
  manifestFingerprint: string
  manifest: MobileWebManifest
  assetsByPath: ReadonlyMap<string, MobileWebAsset>
  fileStatsByPath: ReadonlyMap<string, { size: number; mtimeMs: number }>
}

export async function verifyPackage(
  root: string,
  manifestBytes: Buffer,
  manifestFingerprint: string
): Promise<VerifiedMobileWebPackage> {
  const manifest = parseManifest(manifestBytes)
  if (sha256(serializeMobileWebManifestForBuildId(manifest)) !== manifest.buildId) {
    throw new Error('mobile_web_package_build_invalid')
  }
  const fileStatsByPath = new Map<string, { size: number; mtimeMs: number }>()
  for (const asset of manifest.assets) {
    const path = resolveDeclaredAssetPath(root, asset.path)
    const beforeRead = await stat(path)
    const bytes = await readFile(path)
    const afterRead = await stat(path)
    if (bytes.byteLength !== asset.byteLength || sha256(bytes) !== asset.sha256) {
      throw new Error('mobile_web_package_asset_invalid')
    }
    if (beforeRead.size !== afterRead.size || beforeRead.mtimeMs !== afterRead.mtimeMs) {
      throw new Error('mobile_web_package_asset_changed')
    }
    fileStatsByPath.set(asset.path, { size: afterRead.size, mtimeMs: afterRead.mtimeMs })
  }
  await assertManifestFingerprint(root, manifestFingerprint)
  return {
    root,
    manifestFingerprint,
    manifest,
    assetsByPath: new Map(manifest.assets.map((asset) => [asset.path, asset])),
    fileStatsByPath
  }
}

function parseManifest(manifestBytes: Buffer): MobileWebManifest {
  try {
    return MobileWebManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
  } catch {
    throw new Error('mobile_web_package_build_invalid')
  }
}

export async function readManifestBytes(root: string): Promise<Buffer> {
  try {
    return await readFile(resolve(root, 'manifest.json'))
  } catch {
    throw new Error('mobile_web_package_unavailable')
  }
}

export async function assertManifestFingerprint(root: string, expected: string): Promise<void> {
  if (sha256(await readManifestBytes(root)) !== expected) {
    throw new Error('mobile_web_package_build_changed')
  }
}

export function resolveDeclaredAssetPath(root: string, assetPath: string): string {
  const candidate = resolve(root, ...assetPath.split('/'))
  const child = relative(root, candidate)
  if (child.startsWith('..') || isAbsolute(child)) {
    throw new Error('mobile_web_package_asset_path_invalid')
  }
  return candidate
}

export async function readAssetRange(
  path: string,
  offset: number,
  length: number
): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('mobile_web_package_cancelled')
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
