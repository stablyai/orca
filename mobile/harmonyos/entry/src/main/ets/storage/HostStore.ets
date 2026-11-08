import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { sha256 } from '../transport/crypto/Sha256';
import { utf8Decode } from '../transport/crypto/Bytes';

/**
 * Paired-host catalog: non-secret metadata in preferences, the device token in the
 * Asset Store (on-device keychain equivalent, mirroring upstream pairing-keychain).
 */

export interface HostMeta {
  id: string; // deterministic: first 16 hex chars of sha256(publicKeyB64)
  name: string; // desktop machineName, else endpoint
  endpoint: string;
  publicKeyB64: string;
  lastConnected: number;
}

const PREFS_NAME = 'orca_hosts';
const PREFS_KEY = 'hosts';

function hostIdFromKey(publicKeyB64: string): string {
  let encoded = new util.TextEncoder().encodeInto(publicKeyB64);
  return toHex16(sha256(encoded));
}

function toHex16(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return out;
}

function parseHosts(text: string): HostMeta[] {
  let parsed: Object | null = JSON.parse(text) as Object | null;
  if (parsed === null || !Array.isArray(parsed)) {
    return [];
  }
  let arr = parsed as Array<Object>;
  let hosts: HostMeta[] = [];
  for (let i = 0; i < arr.length; i++) {
    let item = arr[i] as Record<string, Object>;
    let id = item['id'];
    let name = item['name'];
    let endpoint = item['endpoint'];
    let publicKeyB64 = item['publicKeyB64'];
    let lastConnected = item['lastConnected'];
    if (typeof id !== 'string' || typeof name !== 'string' || typeof endpoint !== 'string'
      || typeof publicKeyB64 !== 'string') {
      continue;
    }
    let meta: HostMeta = {
      id: id,
      name: name,
      endpoint: endpoint,
      publicKeyB64: publicKeyB64,
      lastConnected: typeof lastConnected === 'number' ? lastConnected : 0
    };
    hosts.push(meta);
  }
  return hosts;
}

async function loadPrefs(context: common.Context): Promise<preferences.Preferences> {
  return preferences.getPreferences(context, { name: PREFS_NAME });
}

async function readHostList(context: common.Context): Promise<HostMeta[]> {
  let prefs = await loadPrefs(context);
  let raw: string = await prefs.get(PREFS_KEY, '[]') as string;
  return parseHosts(raw);
}

async function writeHostList(context: common.Context, hosts: HostMeta[]): Promise<void> {
  let prefs = await loadPrefs(context);
  let texts: string[] = [];
  for (let i = 0; i < hosts.length; i++) {
    texts.push(JSON.stringify(hosts[i]));
  }
  await prefs.put(PREFS_KEY, `[${texts.join(',')}]`);
  await prefs.flush();
}

export async function listHosts(context: common.Context): Promise<HostMeta[]> {
  return readHostList(context);
}

export function hostIdFor(publicKeyB64: string): string {
  return hostIdFromKey(publicKeyB64);
}

/** Upsert host metadata and its device token (Asset Store secret). */
export async function saveHost(context: common.Context, meta: HostMeta, deviceToken: string): Promise<void> {
  let hosts = await readHostList(context);
  let replaced = false;
  for (let i = 0; i < hosts.length; i++) {
    if (hosts[i].id === meta.id) {
      hosts[i] = meta;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    hosts.push(meta);
  }
  await writeHostList(context, hosts);

  let alias = `orca.token.${meta.id}`;
  let secret: asset.AssetMap = new Map();
  secret.set(asset.Tag.SECRET, new util.TextEncoder().encodeInto(deviceToken));
  secret.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(alias));
  try {
    await asset.add(secret);
  } catch (e) {
    // Likely already exists from a previous pairing — replace the secret.
    let query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(alias));
    let updateMap: asset.AssetMap = new Map();
    updateMap.set(asset.Tag.SECRET, new util.TextEncoder().encodeInto(deviceToken));
    await asset.update(query, updateMap);
  }
}

export async function getDeviceToken(context: common.Context, hostId: string): Promise<string | null> {
  try {
    let query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(`orca.token.${hostId}`));
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    let results: Array<asset.AssetMap> = await asset.query(query);
    if (results.length === 0) {
      return null;
    }
    let value: ESObject = results[0].get(asset.Tag.SECRET);
    if (value === undefined || value === null) {
      return null;
    }
    return utf8Decode(value as Uint8Array);
  } catch (e) {
    return null;
  }
}

export async function deleteHost(context: common.Context, hostId: string): Promise<void> {
  let hosts = await readHostList(context);
  let remaining: HostMeta[] = [];
  for (let i = 0; i < hosts.length; i++) {
    if (hosts[i].id !== hostId) {
      remaining.push(hosts[i]);
    }
  }
  await writeHostList(context, remaining);
  try {
    let query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(`orca.token.${hostId}`));
    await asset.remove(query);
  } catch (e) {
    // already gone
  }
}
