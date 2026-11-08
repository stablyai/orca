import { RelayEndpoint, RelayCredential, readRelayEndpoint, readRelayCredential, isDirectEndpoint } from '../transport/RelayProtocol';
import { BusinessError } from '@kit.BasicServicesKit';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { sha256 } from '../transport/crypto/Sha256';
import { utf8Decode, base64DecodeCanonical } from '../transport/crypto/Bytes';

/**
 * Paired-host catalog: non-secret metadata in preferences, the device token in the
 * Asset Store (on-device keychain equivalent, mirroring upstream pairing-keychain).
 */

export interface HostMeta {
  id: string; // deterministic: first 16 hex chars of sha256(publicKeyB64)
  name: string; // personal override, desktop name, or endpoint
  personalName?: string;
  machineName?: string;
  endpoint: string;
  publicKeyB64: string;
  lastConnected: number;
  relay?: RelayEndpoint;
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
    if (arr[i] === null || typeof arr[i] !== 'object' || Array.isArray(arr[i])) { continue; }
    let item = arr[i] as Record<string, Object>;
    let id = item['id'];
    let name = item['name'];
    let endpoint = item['endpoint'];
    let publicKeyB64 = item['publicKeyB64'];
    let lastConnected = item['lastConnected'];
    if (typeof id !== 'string' || typeof name !== 'string' || typeof endpoint !== 'string'
      || typeof publicKeyB64 !== 'string' || !/^[a-f0-9]{32}$/.test(id) || hostIdFromKey(publicKeyB64) !== id) {
      continue;
    }
    let meta: HostMeta = {
      id: id,
      name: name,
      endpoint: endpoint,
      publicKeyB64: publicKeyB64,
      lastConnected: typeof lastConnected === 'number' ? lastConnected : 0
    };
    if (typeof item['personalName'] === 'string') { meta.personalName = item['personalName'] as string; }
    if (typeof item['machineName'] === 'string') { meta.machineName = item['machineName'] as string; }
    if (item['relay'] !== undefined) {
      try { meta.relay = readRelayEndpoint(item['relay'], publicKeyB64); } catch (e) { }
    }
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
  let previous = await prefs.get(PREFS_KEY, '[]');
  try { await prefs.put(PREFS_KEY, `[${texts.join(',')}]`); await prefs.flush(); }
  catch (e) { await prefs.put(PREFS_KEY, previous); throw e as Error; }
}

export async function listHosts(context: common.Context): Promise<HostMeta[]> {
  return readHostList(context);
}

export function hostIdFor(publicKeyB64: string): string {
  return hostIdFromKey(publicKeyB64);
}

let hostMutation: Promise<void> = Promise.resolve();
function mutateHost(task: () => Promise<void>): Promise<void> {
  let next = hostMutation.catch((): void => {}).then(task);
  hostMutation = next; return next;
}
async function putToken(hostId: string, token: string): Promise<void> {
  let alias = new util.TextEncoder().encodeInto(`orca.token.${hostId}`);
  let secret: asset.AssetMap = new Map();
  secret.set(asset.Tag.ALIAS, alias); secret.set(asset.Tag.SECRET, new util.TextEncoder().encodeInto(token));
  try { await asset.add(secret); }
  catch (e) {
    if ((e as BusinessError).code !== asset.ErrorCode.DUPLICATED) { throw e as Error; }
    let query: asset.AssetMap = new Map(); query.set(asset.Tag.ALIAS, alias);
    let update: asset.AssetMap = new Map(); update.set(asset.Tag.SECRET, new util.TextEncoder().encodeInto(token));
    await asset.update(query, update);
  }
}
async function removeToken(hostId: string): Promise<void> {
  let query: asset.AssetMap = new Map();
  query.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(`orca.token.${hostId}`));
  try { await asset.remove(query); }
  catch (e) { if ((e as BusinessError).code !== asset.ErrorCode.NOT_FOUND) { throw e as Error; } }
}

export function saveHost(context: common.Context, meta: HostMeta, deviceToken: string, relayCredential?: RelayCredential, pairingStartedAt: number = Date.now(), recovering: boolean = false): Promise<void> {
  return mutateHost(async (): Promise<void> => {
    let removedAt = hostRemovalTimestamp(context, meta.id);
    if (!Number.isSafeInteger(pairingStartedAt) || pairingStartedAt < 0 || (removedAt > 0 && pairingStartedAt <= removedAt)) { throw new Error('Pairing was superseded by desktop removal'); }
    let prefs = await loadPrefs(context);
    let lastPairing = prefs.getSync(`paired.${meta.id}`, 0) as number;
    if (pairingStartedAt < lastPairing || (recovering && pairingStartedAt === 0)) { throw new Error('Pairing was superseded by a newer pairing'); }
    let key = base64DecodeCanonical(meta.publicKeyB64);
    if (!key || key.length !== 32 || meta.id !== hostIdFromKey(meta.publicKeyB64)
      || !isDirectEndpoint(meta.endpoint) || !meta.name || meta.name.length > 1024 || !deviceToken) {
      throw new Error('Invalid paired host');
    }
    let hosts = await readHostList(context);
    let oldToken = await getDeviceToken(context, meta.id);
    let oldRelay = await getRelayCredential(context, meta.id);
    if (meta.relay) { readRelayEndpoint(meta.relay, meta.publicKeyB64); }
    if (relayCredential) { readRelayCredential(relayCredential); }
    let at = hosts.findIndex((host: HostMeta): boolean => host.id === meta.id);
    if (at >= 0) {
      let previous = hosts[at]; meta.machineName = meta.machineName ?? meta.name;
      if (previous.personalName) { meta.personalName = previous.personalName; meta.name = previous.personalName; }
      hosts[at] = meta;
    } else { meta.machineName = meta.machineName ?? meta.name; hosts.push(meta); }
    await putToken(meta.id, deviceToken);
    try {
      if (relayCredential) { await putRelayCredential(meta.id, relayCredential); }
      else if (!meta.relay) { await removeRelayCredential(meta.id); }
      prefs.putSync(`paired.${meta.id}`, pairingStartedAt);
      await writeHostList(context, hosts);
    }
    catch (e) {
      prefs.putSync(`paired.${meta.id}`, lastPairing);
      if (oldToken === null) { await removeToken(meta.id); } else { await putToken(meta.id, oldToken); }
      if (oldRelay) { await putRelayCredential(meta.id, oldRelay); } else { await removeRelayCredential(meta.id); }
      throw e as Error;
    }
  });
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
    if ((e as BusinessError).code === asset.ErrorCode.NOT_FOUND) { return null; }
    throw new Error('Device credential storage is unavailable');
  }
}

export function deleteHost(context: common.Context, hostId: string): Promise<void> {
  return mutateHost(async (): Promise<void> => {
    if (!/^[a-f0-9]{32}$/.test(hostId)) { throw new Error('Invalid host identity'); }
    let hosts = await readHostList(context);
    let oldToken = await getDeviceToken(context, hostId);
    let oldRelay = await getRelayCredential(context, hostId);
    let prefs = await loadPrefs(context); prefs.putSync(`removed.${hostId}`, Date.now()); prefs.flushSync();
    await clearHostPairingJournal(context, hostId);
    await removeToken(hostId);
    try { await removeRelayCredential(hostId); await writeHostList(context, hosts.filter((host: HostMeta): boolean => host.id !== hostId)); }
    catch (e) {
      if (oldToken !== null) { await putToken(hostId, oldToken); }
      if (oldRelay) { await putRelayCredential(hostId, oldRelay); }
      throw e as Error;
    }
  });
}

async function putRelayCredential(hostId: string, credential: RelayCredential): Promise<void> {
  let alias = new util.TextEncoder().encodeInto(`orca.relay.${hostId}`);
  let encoded = new util.TextEncoder().encodeInto(JSON.stringify(credential));
  let secret: asset.AssetMap = new Map(); secret.set(asset.Tag.ALIAS, alias); secret.set(asset.Tag.SECRET, encoded);
  try { await asset.add(secret); }
  catch (e) {
    if ((e as BusinessError).code !== asset.ErrorCode.DUPLICATED) { throw e as Error; }
    let query: asset.AssetMap = new Map(); query.set(asset.Tag.ALIAS, alias);
    let update: asset.AssetMap = new Map(); update.set(asset.Tag.SECRET, encoded); await asset.update(query, update);
  }
}
async function removeRelayCredential(hostId: string): Promise<void> {
  let query: asset.AssetMap = new Map(); query.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(`orca.relay.${hostId}`));
  try { await asset.remove(query); }
  catch (e) { if ((e as BusinessError).code !== asset.ErrorCode.NOT_FOUND) { throw e as Error; } }
}
export async function getRelayCredential(context: common.Context, hostId: string): Promise<RelayCredential | null> {
  if (!/^[a-f0-9]{32}$/.test(hostId)) { throw new Error('Invalid relay host identity'); }
  let query: asset.AssetMap = new Map();
  query.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(`orca.relay.${hostId}`));
  query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
  try {
    let results = await asset.query(query);
    if (!results.length) { return null; }
    let secret = results[0].get(asset.Tag.SECRET) as Uint8Array;
    return readRelayCredential(JSON.parse(utf8Decode(secret)));
  } catch (e) {
    if ((e as BusinessError).code === asset.ErrorCode.NOT_FOUND) { return null; }
    throw new Error('Relay credential storage is unavailable');
  }
}
export interface RelayCredentialFence { deviceToken: string; hash: string; version: number; pendingReqId?: string; }
export function updateRelayCredential(context: common.Context, hostId: string, credential: RelayCredential, endpoint?: RelayEndpoint, fence?: RelayCredentialFence): Promise<void> {
  return mutateHost(async (): Promise<void> => {
    let hosts = await readHostList(context);
    let host = hosts.find((item: HostMeta): boolean => item.id === hostId);
    if (!host) { throw new Error('Relay host was removed'); }
    if (fence) {
      if (await getDeviceToken(context, hostId) !== fence.deviceToken) { throw new Error('Relay owner was superseded'); }
      let held = await getRelayCredential(context, hostId);
      if (!held || held.hash !== fence.hash || held.version !== fence.version || held.pendingReqId !== fence.pendingReqId) {
        if (held && held.hash === credential.hash && held.version === credential.version && !held.pendingReqId) { return; }
        throw new Error('Relay credential revision was superseded');
      }
    }
    readRelayCredential(credential);
    let resolved: RelayEndpoint | undefined = undefined;
    if (endpoint) {
      resolved = readRelayEndpoint(endpoint, host.publicKeyB64);
      if (host.relay && (resolved.assignmentEpoch < host.relay.assignmentEpoch
        || (resolved.assignmentEpoch === host.relay.assignmentEpoch && resolved.cellUrl !== host.relay.cellUrl))) {
        throw new Error('Relay assignment was superseded');
      }
    }
    await putRelayCredential(hostId, credential);
    if (resolved) { host.relay = resolved; await writeHostList(context, hosts); }
  });
}

export function updateHostNameAndEndpoint(context: common.Context, hostId: string, personalName: string, endpoint: string): Promise<void> {
  return mutateHost(async (): Promise<void> => {
    let name = personalName.trim(); let address = endpoint.trim();
    if (!/^[a-f0-9]{32}$/.test(hostId) || name.length > 1024 || /[\x00-\x1f]/.test(name)
      || !isDirectEndpoint(address)) { throw new Error('Invalid desktop name or endpoint'); }
    let hosts = await readHostList(context);
    let host = hosts.find((item: HostMeta): boolean => item.id === hostId);
    if (!host) { throw new Error('Desktop was removed'); }
    let machineName = host.machineName ?? (!host.personalName ? host.name : '');
    host.machineName = machineName; host.personalName = name; host.name = name || machineName || address; host.endpoint = address;
    await writeHostList(context, hosts);
  });
}

export function hostRemovalTimestamp(context: common.Context, hostId: string): number {
  let prefs = preferences.getPreferencesSync(context, { name: PREFS_NAME });
  return prefs.getSync(`removed.${hostId}`, 0) as number;
}
export async function clearHostPairingJournal(context: common.Context, hostId: string): Promise<void> {
  let query: asset.AssetMap = new Map(); query.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(`orca.relay.pair.${hostId}`));
  try { await asset.remove(query); }
  catch (e) { if ((e as BusinessError).code !== asset.ErrorCode.NOT_FOUND) { throw e as Error; } }
  let prefs = preferences.getPreferencesSync(context, { name: 'orca_relay_pairing' });
  let ids = JSON.parse(prefs.getSync('pending', '[]') as string) as string[];
  prefs.putSync('pending', JSON.stringify(ids.filter((id: string): boolean => id !== hostId))); prefs.flushSync();
}
