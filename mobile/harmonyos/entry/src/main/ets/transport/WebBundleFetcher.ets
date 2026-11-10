import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import fflateModule from '../vendor/fflate-umd.js';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from './SpikeRpcClient';
import { base64Decode, utf8Encode } from './crypto/Bytes';
import { sha256 } from './crypto/Sha256';
import bundleCompat, { BundleProtocolFacts, DesktopProtocolFacts } from '../vendor/bundle-compat.js';

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
  canOwnHostAreaAcrossLayouts?: boolean;
}

export interface BundleManifest extends BundleProtocolFacts {
  buildId: string;
  entrypoint: string;
  desktopVersion: string;
  assets: BundleAsset[];
  routes: BundleRoute[];
  chunkBytes: number;
  rangeBytes: number; // 0 when the host does not advertise range support
}

export type BundleRemedy = 'desktop' | 'mobile' | 'workspace';

export class BundleCompatibilityError extends Error {
  readonly remedy: BundleRemedy;

  constructor(remedy: BundleRemedy, reason: string) {
    super(reason);
    this.remedy = remedy;
  }
}

export interface CachedWebBundle {
  manifest: BundleManifest;
  directory: string;
}

export interface DesktopBundleStatus {
  hostStatus: DesktopProtocolFacts;
  capabilities: string[];
}

const RANGE_METHOD = 'mobileWeb.bundle.range';
const CHUNK_METHOD = 'mobileWeb.bundle.chunk';
const MANIFEST_METHOD = 'mobileWeb.bundle.manifest';
const MAX_CACHE_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_ROUTES = 64;
const MAX_ROUTE_GRANTS = 16;

function protocolNumber(value: Object): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function manifestFields(reply: Object | null): Record<string, Object> {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) { throw new Error('Invalid manifest reply'); }
  let fields = (reply as Record<string, Object>)['manifest'];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { throw new Error('Missing manifest'); }
  return fields as Record<string, Object>;
}

function protocolFacts(fields: Record<string, Object>): BundleProtocolFacts {
  let schemaVersion = protocolNumber(fields['schemaVersion']);
  if (schemaVersion === undefined) { throw new Error('Missing manifest schema'); }
  if (!bundleCompat.SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new BundleCompatibilityError('mobile', 'bundle-shell-too-old');
  }
  let runtimeVersion = protocolNumber(fields['runtimeProtocolVersion']);
  let minRuntimeVersion = protocolNumber(fields['minCompatibleRuntimeProtocolVersion']);
  if (runtimeVersion === undefined || minRuntimeVersion === undefined) { throw new Error('Missing manifest protocol'); }
  return { schemaVersion: schemaVersion, runtimeProtocolVersion: runtimeVersion,
    minCompatibleRuntimeProtocolVersion: minRuntimeVersion, pageVersion: protocolNumber(fields['pageVersion']) ?? 0 };
}

function readGrants(value: Object): string[] {
  if (!Array.isArray(value) || value.length > MAX_ROUTE_GRANTS) { throw new Error('Invalid route grants'); }
  let grants: string[] = [];
  (value as Object[]).forEach((item: Object): void => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 64) { throw new Error('Invalid route grant'); }
    if (!grants.includes(item)) { grants.push(item); }
  });
  return grants;
}

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

function bundleFingerprint(manifest: BundleManifest): string {
  return bytesToHex(sha256(utf8Encode(JSON.stringify(manifest))));
}

function bundleDirectory(context: common.Context, manifest: BundleManifest, fingerprint: string): string {
  return `${context.cacheDir}/webshell/${manifest.buildId}-${fingerprint}`;
}

function pairedBundlePath(context: common.Context, hostId: string): string {
  if (!/^[a-f0-9]{32}$/.test(hostId)) { throw new Error('Invalid cached bundle host'); }
  return `${context.cacheDir}/webshell/paired-${hostId}.json`;
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

  async fetchDesktopStatus(): Promise<DesktopBundleStatus> {
    let status = await this.client.request('status.get', null, 8000);
    if (!(status instanceof RpcSuccess)) { throw new Error('Desktop status unavailable'); }
    let reply = JSON.parse(status.result) as Record<string, Object>;
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) { throw new Error('Invalid desktop status'); }
    let hostStatus: DesktopProtocolFacts = { protocolVersion: protocolNumber(reply['protocolVersion']),
      minCompatibleMobileVersion: protocolNumber(reply['minCompatibleMobileVersion']) };
    let general = bundleCompat.evaluateCompat({ desktopProtocolVersion: hostStatus.protocolVersion,
      desktopMinCompatibleMobileVersion: hostStatus.minCompatibleMobileVersion });
    if (general.kind === 'blocked') {
      throw new BundleCompatibilityError(general.reason === 'mobile-too-old' ? 'mobile' : 'desktop', general.reason ?? '');
    }
    let advertised = reply['capabilities'];
    let capabilities = Array.isArray(advertised) && (advertised as Object[]).every((value: Object): boolean =>
      typeof value === 'string') ? advertised as string[] : [];
    let result: DesktopBundleStatus = { capabilities: capabilities, hostStatus: hostStatus };
    WebBundleFetcher.requireCompatibility(result, null);
    return result;
  }

  async fetchManifest(status?: DesktopBundleStatus): Promise<BundleManifest> {
    let desktop = status ?? await this.fetchDesktopStatus();
    let manifestReply = await this.requestJson(MANIFEST_METHOD, null);
    WebBundleFetcher.requireCompatibility(desktop, protocolFacts(manifestFields(manifestReply)));
    return WebBundleFetcher.readManifest(manifestReply);
  }

  static requireCompatibility(desktop: DesktopBundleStatus, manifest: BundleProtocolFacts | null): void {
    let verdict = bundleCompat.evaluateMobileWebBundleCompat({
      hostCapabilities: desktop.capabilities, hostStatus: desktop.hostStatus, manifest: manifest
    });
    if (verdict.kind === 'blocked') {
      throw new BundleCompatibilityError(verdict.side === 'mobile' ? 'workspace' : 'desktop', verdict.reason ?? '');
    }
  }

  private static readManifest(parsed: Object | null): BundleManifest {
    let m = manifestFields(parsed);
    let facts = protocolFacts(m);
    let rec = parsed as Record<string, Object>;
    let buildId = m['buildId'];
    let entrypoint = m['entrypoint'];
    let desktopVersion = m['desktopVersion'];
    if (typeof buildId !== 'string' || typeof entrypoint !== 'string' || typeof desktopVersion !== 'string') {
      throw new Error('manifest missing buildId/entrypoint/desktopVersion');
    }
    let assetsValue: Object = m['assets'];
    let routesValue: Object = m['routes'] ?? [];
    if (!Array.isArray(assetsValue) || !Array.isArray(routesValue) || routesValue.length > MAX_PAGE_ROUTES) {
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
      if (typeof pathname !== 'string' || pathname.length > 255 || !/^\/(?![/\\])[^?#\s]*$/.test(pathname)) {
        throw new Error('Invalid page route');
      }
      let route: BundleRoute = {
        pathname: pathname,
        grants: readGrants(rec2['grants']),
        optionalGrants: rec2['optionalGrants'] === undefined ? [] : readGrants(rec2['optionalGrants']),
        canOwnHostArea: rec2['canOwnHostArea'] === true,
        canOwnHostAreaAcrossLayouts: rec2['canOwnHostAreaAcrossLayouts'] === true
      };
      routes.push(route);
    }
    let chunkBytesValue: Object = rec['chunkBytes'];
    let rangeBytesValue: Object = rec['rangeBytes'];
    let manifest: BundleManifest = {
      schemaVersion: facts.schemaVersion,
      runtimeProtocolVersion: facts.runtimeProtocolVersion,
      minCompatibleRuntimeProtocolVersion: facts.minCompatibleRuntimeProtocolVersion,
      buildId: buildId,
      entrypoint: entrypoint,
      desktopVersion: desktopVersion,
      pageVersion: facts.pageVersion,
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
    let temp = `${baseDir}-asset.tmp`;
    try {
      let file = fs.openSync(temp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        if (fs.writeSync(file.fd, bytes.buffer) !== bytes.byteLength) { throw new Error('Incomplete bundle asset write'); }
      } finally { fs.closeSync(file); }
      // Other documents can still hold a descriptor for the original asset during repair.
      fs.renameSync(temp, target);
    } catch (e) {
      try { fs.unlinkSync(temp); } catch (ignored) {}
      throw e as Error;
    }
  }

  private static isComplete(manifest: BundleManifest, baseDir: string, fingerprint: string): boolean {
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

  static readPairedBundle(context: common.Context, hostId: string, pairedAt: number): CachedWebBundle | null {
    try {
      let path = pairedBundlePath(context, hostId);
      if (fs.statSync(path).size > MAX_CACHE_METADATA_BYTES) { return null; }
      let metadata = JSON.parse(fs.readTextSync(path)) as Record<string, Object>;
      if (metadata['pairedAt'] !== pairedAt) { return null; }
      let manifest = WebBundleFetcher.readManifest(metadata);
      if (manifest.pageVersion < bundleCompat.MOBILE_WEB_PAGE_VERSION_FLOOR) { return null; }
      let fingerprint = bundleFingerprint(manifest);
      let directory = bundleDirectory(context, manifest, fingerprint);
      return WebBundleFetcher.isComplete(manifest, directory, fingerprint)
        ? { manifest: manifest, directory: directory } : null;
    } catch (e) { return null; }
  }

  static rememberPairedBundle(context: common.Context, hostId: string, pairedAt: number, manifest: BundleManifest): void {
    let path = pairedBundlePath(context, hostId);
    let temp = `${path}.tmp`;
    let content = utf8Encode(JSON.stringify({ pairedAt: pairedAt, manifest: manifest,
      chunkBytes: manifest.chunkBytes, rangeBytes: manifest.rangeBytes }));
    if (content.length > MAX_CACHE_METADATA_BYTES) { return; }
    try {
      let file = fs.openSync(temp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        if (fs.writeSync(file.fd, content.buffer) !== content.byteLength) { return; }
        fs.fsyncSync(file.fd);
      } finally { fs.closeSync(file); }
      fs.renameSync(temp, path);
    } finally {
      try { fs.unlinkSync(temp); } catch (e) {}
    }
  }

  static forgetPairedBundle(context: common.Context, hostId: string): void {
    try { fs.unlinkSync(pairedBundlePath(context, hostId)); } catch (e) {}
  }

  static invalidateCompletedBundle(context: common.Context, manifest: BundleManifest): void {
    validateManifest(manifest);
    let fingerprint = bundleFingerprint(manifest);
    let directory = bundleDirectory(context, manifest, fingerprint);
    try { fs.unlinkSync(`${directory}/.complete`); }
    catch (e) {
      if (WebBundleFetcher.isComplete(manifest, directory, fingerprint)) { throw e as Error; }
    }
  }

  completedDirectory(manifest: BundleManifest): string | null {
    let fingerprint = bundleFingerprint(manifest);
    let directory = bundleDirectory(this.context, manifest, fingerprint);
    return WebBundleFetcher.isComplete(manifest, directory, fingerprint) ? directory : null;
  }

  async ensureBundle(manifest: BundleManifest, onProgress?: BundleProgress): Promise<string> {
    validateManifest(manifest);
    let fingerprint = bundleFingerprint(manifest);
    let baseDir = bundleDirectory(this.context, manifest, fingerprint);
    if (WebBundleFetcher.isComplete(manifest, baseDir, fingerprint)) { return baseDir; }
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
    try {
      if (fs.writeSync(file.fd, fingerprint) !== fingerprint.length) { throw new Error('Incomplete bundle marker write'); }
    } finally { fs.closeSync(file); }
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
