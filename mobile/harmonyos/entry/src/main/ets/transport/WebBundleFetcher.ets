import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import fflateModule from '../vendor/fflate-umd.js';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from './SpikeRpcClient';
import { base64Decode, utf8Encode } from './crypto/Bytes';
import { sha256 } from './crypto/Sha256';

/**
 * Desktop web-bundle download pipeline (Phase 2a of upstream mobile/src/transport/web-bundle):
 * manifest → per-asset range windows (gzip or identity) → sha256-verified reassembly →
 * sandbox files under <filesDir>/webshell/<buildId>/.
 *
 * Wire contract: src/shared/mobile-web-bundle/bundle-rpc-contract.ts + manifest-contract.ts.
 */

export interface BundleAsset {
  path: string;
  sha256: string;
  byteLength: number;
  contentType: string;
}

export interface BundleRoute {
  pathname: string;
  grants: string[];
  optionalGrants: string[];
  canOwnHostArea: boolean;
}

export interface BundleManifest {
  buildId: string;
  entrypoint: string;
  desktopVersion: string;
  pageVersion: number;
  assets: BundleAsset[];
  routes: BundleRoute[];
  chunkBytes: number;
  rangeBytes: number; // 0 when the host does not advertise range support
}

const RANGE_METHOD = 'mobileWeb.bundle.range';
const CHUNK_METHOD = 'mobileWeb.bundle.chunk';
const MANIFEST_METHOD = 'mobileWeb.bundle.manifest';

export function isSafeBundlePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || /[\\%?#\x00-\x1f:]/.test(path)) { return false; }
  return path.split('/').every((part: string): boolean => part.length > 0 && part !== '.' && part !== '..');
}

function validateManifest(manifest: BundleManifest): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(manifest.buildId) || !isSafeBundlePath(manifest.entrypoint)) {
    throw new Error('Invalid bundle identity or entrypoint');
  }
  if (!Number.isInteger(manifest.chunkBytes) || manifest.chunkBytes < 1 || manifest.chunkBytes > 1024 * 1024
    || !Number.isInteger(manifest.rangeBytes) || manifest.rangeBytes < 0 || manifest.rangeBytes > 4 * 1024 * 1024
    || manifest.assets.length > 4096) { throw new Error('Invalid bundle limits'); }
  let total = 0;
  let paths: Set<string> = new Set();
  for (let i = 0; i < manifest.assets.length; i++) {
    let asset = manifest.assets[i];
    if (!isSafeBundlePath(asset.path) || asset.path === '.complete' || paths.has(asset.path)
      || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isInteger(asset.byteLength)
      || asset.byteLength < 0 || asset.byteLength > 64 * 1024 * 1024) { throw new Error('Invalid bundle asset'); }
    paths.add(asset.path); total += asset.byteLength;
  }
  if (!paths.has(manifest.entrypoint) || total > 256 * 1024 * 1024) { throw new Error('Invalid bundle size or entrypoint'); }
}

function esObjectBytes(value: ESObject): Uint8Array {
  return value as Uint8Array;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return out;
}

type BundleProgress = (received: number, total: number) => void;

class BundleInstall {
  task: Promise<string> = Promise.resolve('');
  received: number = 0;
  total: number = 0;
  listeners: Set<BundleProgress> = new Set();
  readonly client: SpikeRpcClient;
  constructor(client: SpikeRpcClient) { this.client = client; }

  progress(received: number, total: number): void {
    this.received = received; this.total = total;
    this.listeners.forEach((listener: BundleProgress): void => listener(received, total));
  }

  async join(onProgress?: BundleProgress): Promise<string> {
    if (onProgress) {
      this.listeners.add(onProgress);
      onProgress(this.received, this.total);
    }
    try { return await this.task; }
    finally { if (onProgress) { this.listeners.delete(onProgress); } }
  }
}

const bundleInstalls: Map<string, BundleInstall> = new Map();

export class WebBundleFetcher {
  private client: SpikeRpcClient;
  private context: common.Context;

  constructor(client: SpikeRpcClient, context: common.Context) {
    this.client = client;
    this.context = context;
  }

  private async requestJson(method: string, paramsJson: string | null): Promise<Object | null> {
    let id = `wb-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    let response: RpcResponse = await this.client.requestRaw(id, this.client.buildWire(id, method, paramsJson));
    if (!(response instanceof RpcSuccess)) {
      throw new Error(`${method} failed: ${(response as Object as Record<string, Object>)['errorCode']}`);
    }
    let parsed: Object | null = JSON.parse(response.result) as Object | null;
    return parsed;
  }

  private static readAsset(item: Object): BundleAsset | null {
    let rec = item as Record<string, Object>;
    let path = rec['path'];
    let sha = rec['sha256'];
    let byteLength = rec['byteLength'];
    let contentType = rec['contentType'];
    if (typeof path !== 'string' || typeof sha !== 'string' || typeof byteLength !== 'number'
      || typeof contentType !== 'string') {
      return null;
    }
    let asset: BundleAsset = { path: path, sha256: sha, byteLength: byteLength, contentType: contentType };
    return asset;
  }

  async fetchManifest(): Promise<BundleManifest> {
    let parsed: Object | null = await this.requestJson(MANIFEST_METHOD, null);
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('manifest reply is not an object');
    }
    let rec = parsed as Record<string, Object>;
    let manifestValue: Object = rec['manifest'];
    if (manifestValue === null || manifestValue === undefined || typeof manifestValue !== 'object') {
      throw new Error('manifest reply missing manifest');
    }
    let m = manifestValue as Record<string, Object>;
    let buildId = m['buildId'];
    let entrypoint = m['entrypoint'];
    let desktopVersion = m['desktopVersion'];
    if (typeof buildId !== 'string' || typeof entrypoint !== 'string' || typeof desktopVersion !== 'string') {
      throw new Error('manifest missing buildId/entrypoint/desktopVersion');
    }
    let assetsValue: Object = m['assets'];
    let routesValue: Object = m['routes'];
    if (!Array.isArray(assetsValue) || !Array.isArray(routesValue)) {
      throw new Error('manifest assets/routes missing');
    }
    let assets: BundleAsset[] = [];
    let assetsArr = assetsValue as Array<Object>;
    for (let i = 0; i < assetsArr.length; i++) {
      let asset = WebBundleFetcher.readAsset(assetsArr[i]);
      if (asset === null) { throw new Error('Invalid manifest asset'); }
      assets.push(asset);
    }
    if (assets.length === 0) {
      throw new Error('manifest has no readable assets');
    }
    let routes: BundleRoute[] = [];
    let routesArr = routesValue as Array<Object>;
    for (let i = 0; i < routesArr.length; i++) {
      let rec2 = routesArr[i] as Record<string, Object>;
      let pathname = rec2['pathname'];
      if (typeof pathname !== 'string') {
        continue;
      }
      let grants: string[] = [];
      let grantsValue: Object = rec2['grants'];
      if (Array.isArray(grantsValue)) {
        let g = grantsValue as Array<Object>;
        for (let j = 0; j < g.length; j++) {
          if (typeof g[j] === 'string') {
            grants.push(g[j] as string);
          }
        }
      }
      let optionalGrants: string[] = [];
      let optionalValue: Object = rec2['optionalGrants'];
      if (Array.isArray(optionalValue)) {
        let g = optionalValue as Array<Object>;
        for (let j = 0; j < g.length; j++) {
          if (typeof g[j] === 'string') {
            optionalGrants.push(g[j] as string);
          }
        }
      }
      let route: BundleRoute = {
        pathname: pathname,
        grants: grants,
        optionalGrants: optionalGrants,
        canOwnHostArea: rec2['canOwnHostArea'] === true
      };
      routes.push(route);
    }
    let chunkBytesValue: Object = rec['chunkBytes'];
    let rangeBytesValue: Object = rec['rangeBytes'];
    let pageVersionValue: Object = m['pageVersion'];
    let manifest: BundleManifest = {
      buildId: buildId,
      entrypoint: entrypoint,
      desktopVersion: desktopVersion,
      pageVersion: typeof pageVersionValue === 'number' && Number.isSafeInteger(pageVersionValue) && pageVersionValue > 0 ? pageVersionValue : 0,
      assets: assets,
      routes: routes,
      chunkBytes: typeof chunkBytesValue === 'number' ? chunkBytesValue : 49152,
      rangeBytes: typeof rangeBytesValue === 'number' ? rangeBytesValue : 0
    };
    validateManifest(manifest);
    return manifest;
  }

  private async fetchWindow(manifest: BundleManifest, asset: BundleAsset, offset: number,
    windowBytes: number): Promise<Uint8Array> {
    let params: Record<string, Object> = {
      'buildId': manifest.buildId,
      'path': asset.path,
      'offset': offset
    };
    let method = windowBytes === manifest.chunkBytes ? CHUNK_METHOD : RANGE_METHOD;
    let parsed: Object | null = await this.requestJson(method, JSON.stringify(params));
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(`${method} reply is not an object`);
    }
    let rec = parsed as Record<string, Object>;
    // Restated window header must match the request (upstream reply-schemas).
    if (rec['path'] !== asset.path || rec['offset'] !== offset || rec['buildId'] !== manifest.buildId) {
      throw new Error(`${method} window header mismatch`);
    }
    let dataBase64 = rec['dataBase64'];
    if (typeof dataBase64 !== 'string') {
      throw new Error(`${method} reply missing dataBase64`);
    }
    let raw = base64Decode(dataBase64);
    if (method === RANGE_METHOD) {
      let encoding = rec['encoding'];
      if (encoding === 'gzip') {
        let mod: ESObject = fflateModule as ESObject;
        let gunzipFn: ESObject = mod['gunzipSync'];
        let expected = Math.min(windowBytes, asset.byteLength - offset);
        let out = new Uint8Array(expected + 1);
        return esObjectBytes(gunzipFn(raw, { out: out }));
      }
    }
    return raw;
  }

  private async downloadAsset(manifest: BundleManifest, asset: BundleAsset, baseDir: string,
    onWindow: (bytes: number) => void): Promise<void> {
    let bytes = new Uint8Array(asset.byteLength);
    let windowSize = manifest.rangeBytes > 0 ? manifest.rangeBytes : manifest.chunkBytes;
    for (let offset = 0; offset < asset.byteLength; offset += windowSize) {
      let windowData = await this.fetchWindow(manifest, asset, offset, windowSize);
      if (windowData.length !== Math.min(windowSize, asset.byteLength - offset)) {
        throw new Error(`window overflows asset ${asset.path}`);
      }
      bytes.set(windowData, offset);
      onWindow(windowData.length);
    }
    let digest = bytesToHex(sha256(bytes));
    if (digest !== asset.sha256) {
      throw new Error(`asset ${asset.path} sha256 mismatch`);
    }
    let target = `${baseDir}/${asset.path}`;
    let dirIndex = target.lastIndexOf('/');
    let dir = target.substring(0, dirIndex);
    try {
      fs.mkdirSync(dir, true);
    } catch (e) {
      // HarmonyOS mkdirSync throws File exists even with recursion — ignore.
    }
    let file = fs.openSync(target, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try { fs.writeSync(file.fd, bytes.buffer); }
    finally { fs.closeSync(file); }
  }

  private isComplete(manifest: BundleManifest, baseDir: string, fingerprint: string): boolean {
    let marker = `${baseDir}/.complete`;
    try {
      if (fs.readTextSync(marker) === fingerprint) {
        let complete = true;
        for (let i = 0; i < manifest.assets.length; i++) {
          let asset = manifest.assets[i];
          if (fs.statSync(`${baseDir}/${asset.path}`).size !== asset.byteLength) { complete = false; break; }
        }
        if (complete) { return true; }
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  async ensureBundle(manifest: BundleManifest, onProgress?: BundleProgress): Promise<string> {
    validateManifest(manifest);
    let fingerprint = bytesToHex(sha256(utf8Encode(JSON.stringify(manifest))));
    let baseDir = `${this.context.cacheDir}/webshell/${manifest.buildId}-${fingerprint}`;
    if (this.isComplete(manifest, baseDir, fingerprint)) { return baseDir; }
    let pending = bundleInstalls.get(baseDir);
    if (pending) {
      try { return await pending.join(onProgress); }
      catch (e) {
        if (pending.client === this.client) { throw e as Error; }
        return await this.ensureBundle(manifest, onProgress);
      }
    }
    let install = new BundleInstall(this.client);
    bundleInstalls.set(baseDir, install);
    install.task = this.installBundle(manifest, baseDir, fingerprint, (received: number, total: number): void => {
      install.progress(received, total);
    }).finally((): void => { bundleInstalls.delete(baseDir); });
    return await install.join(onProgress);
  }

  private async installBundle(manifest: BundleManifest, baseDir: string, fingerprint: string,
    onProgress: BundleProgress): Promise<string> {
    let received = 0;
    let total = manifest.assets.reduce((sum: number, asset: BundleAsset): number => sum + asset.byteLength, 0);
    onProgress?.(received, total);
    let onWindow = (bytes: number): void => {
      received += bytes;
      onProgress?.(received, total);
    };
    for (let i = 0; i < manifest.assets.length; i++) {
      await this.downloadAsset(manifest, manifest.assets[i], baseDir, onWindow);
    }
    try {
      fs.mkdirSync(baseDir, true);
    } catch (e) {
      // ignore — see downloadAsset
    }
    let file = fs.openSync(`${baseDir}/.complete`, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try { fs.writeSync(file.fd, fingerprint); } finally { fs.closeSync(file); }
    return baseDir;
  }

  static contentTypeFor(manifest: BundleManifest, relPath: string): string {
    for (let i = 0; i < manifest.assets.length; i++) {
      if (manifest.assets[i].path === relPath) {
        return manifest.assets[i].contentType;
      }
    }
    return 'application/octet-stream';
  }
}
