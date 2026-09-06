import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  MOBILE_WEB_PACKAGE_CHUNK_BYTES,
  serializeMobileWebManifestForBuildId,
  type MobileWebAsset,
  type MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebPackageStager } from '../mobile-web/mobile-web-package-downloader'

export type RelayMobileWebPackageFixture = {
  root: string
  manifest: MobileWebManifest
  bytesByPath: ReadonlyMap<string, Uint8Array>
}

export type RecordingRelayPackageStager = MobileWebPackageStager<{ buildId: string }> & {
  events: string[]
  writes: { path: string; offset: number; bytes: Uint8Array }[]
}

export function createRelayMobileWebPackageFixture(): RelayMobileWebPackageFixture {
  const root = mkdtempSync(join(tmpdir(), 'orca-mobile-relay-package-'))
  const document = Buffer.from('<!doctype html><title>Relay Orca</title>', 'utf8')
  const script = Buffer.alloc(MOBILE_WEB_PACKAGE_CHUNK_BYTES + 17, 0x61)
  const scriptHash = sha256(script)
  const assets: MobileWebAsset[] = [
    {
      path: `assets/${scriptHash}.js`,
      sha256: scriptHash,
      byteLength: script.byteLength,
      contentType: 'text/javascript; charset=utf-8',
      role: 'script'
    },
    {
      path: 'index.html',
      sha256: sha256(document),
      byteLength: document.byteLength,
      contentType: 'text/html; charset=utf-8',
      role: 'document'
    }
  ]
  const seed: MobileWebManifest = {
    schemaVersion: MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
    buildId: '0'.repeat(64),
    bridge: {
      minimum: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      testedThrough: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    },
    entrypoint: 'index.html',
    totalBytes: assets.reduce((total, asset) => total + asset.byteLength, 0),
    assets
  }
  const manifest = {
    ...seed,
    buildId: sha256(serializeMobileWebManifestForBuildId(seed))
  }
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, ...assets[0]!.path.split('/')), script)
  writeFileSync(join(root, 'index.html'), document)
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
  return {
    root,
    manifest,
    bytesByPath: new Map([
      [assets[0]!.path, script],
      ['index.html', document]
    ])
  }
}

export function createRecordingRelayPackageStager(): RecordingRelayPackageStager {
  const events: string[] = []
  const writes: RecordingRelayPackageStager['writes'] = []
  return {
    events,
    writes,
    async begin() {
      events.push('begin')
    },
    async writeAssetChunk(asset, offset, bytes) {
      events.push(`write:${asset.path}:${offset}`)
      writes.push({ path: asset.path, offset, bytes: Uint8Array.from(bytes) })
    },
    async finishAsset(asset) {
      events.push(`finish:${asset.path}`)
    },
    async commit(manifest) {
      events.push('commit')
      return { buildId: manifest.buildId }
    },
    async abort() {
      events.push('abort')
    }
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
