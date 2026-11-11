import { PairingRelay, RelayEndpoint, RelayCredential, readRelayEndpoint, readRelayCredential, isDirectEndpoint } from '../transport/RelayProtocol';
import { BusinessError } from '@kit.BasicServicesKit';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { sha256 } from '../transport/crypto/Sha256';
import { utf8Decode, base64DecodeCanonical } from '../transport/crypto/Bytes';
import { DeviceRowStore } from './DeviceRowStore';
import { HostMachineDescriptor, readHostMachineDescriptor } from './HostMachine';
import { deletePageStorage } from './PageStorageStore';
import { clearHomeResume } from '../home/HomeResume';

/**
 * Paired-host catalog: non-secret metadata in preferences, the device token in the
 * Asset Store (on-device keychain equivalent, mirroring upstream pairing-keychain).
 */

export interface HostMeta extends HostMachineDescriptor {
  id: string; // deterministic: first 16 hex chars of sha256(publicKeyB64)
  name: string; // personal override, desktop name, or endpoint
  personalName?: string;
  machineName?: string;
  endpoint: string;
  publicKeyB64: string;
  lastConnected: number;
  relay?: RelayEndpoint;
}

export interface PairingJournal {
  startedAt: number;
  reqId: string;
  token: string;
  hash: string;
  offerKey: string;
  deviceToken: string;
  replacementToken?: string;
  cancelled?: boolean;
  committedMeta?: HostMeta;
  credential?: RelayCredential;
  draft?: HostMeta;
  relay?: PairingRelay;
}

const PREFS_NAME = 'orca_hosts';
const PREFS_KEY = 'hosts';
const PAIRING_PREFS_NAME = 'orca_relay_pairing';
const PAIRING_PENDING_KEY = 'pending';
const CLEANUP_PREFIX = 'cleanup.';
const CLEANUP_CONFIRM_MS = 3000;
const cleanupListeners = new Set<() => void>();
const cleanupRequests = new Map<string, Promise<void>>();

export interface HostCredentialCleanupState { count: number; storageUnreadable: boolean; }

function pendingCleanupIds(prefs: preferences.Preferences): string[] {
  return Object.keys(prefs.getAllSync()).filter((key: string): boolean =>
    /^cleanup\.[a-f0-9]{32}$/.test(key) && prefs.getSync(key, false) === true)
    .map((key: string): string => key.slice(CLEANUP_PREFIX.length));
}

export async function loadPendingHostCredentialCleanup(context: common.Context): Promise<HostCredentialCleanupState> {
  try { return { count: pendingCleanupIds(await loadPrefs(context)).length, storageUnreadable: false }; }
  catch (e) { return { count: 0, storageUnreadable: true }; }
}

export function subscribePendingHostCredentialCleanup(listener: () => void): () => void {
  cleanupListeners.add(listener);
  return (): void => { cleanupListeners.delete(listener); };
}

function notifyCleanupChanged(): void {
  cleanupListeners.forEach((listener: () => void): void => { try { listener(); } catch (e) {} });
}

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
    let descriptor = readHostMachineDescriptor(item);
    meta.hostPlatform = descriptor.hostPlatform; meta.hostMachine = descriptor.hostMachine;
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

async function writeHostList(context: common.Context, hosts: HostMeta[], beforeWrite?: () => void): Promise<void> {
  let prefs = await loadPrefs(context);
  let previous = prefs.getSync(PREFS_KEY, '[]');
  try { beforeWrite?.(); prefs.putSync(PREFS_KEY, JSON.stringify(hosts)); prefs.flushSync(); }
  catch (e) { prefs.putSync(PREFS_KEY, previous); throw e as Error; }
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

export function saveHost(context: common.Context, meta: HostMeta, deviceToken: string, relayCredential?: RelayCredential,
  pairingStartedAt: number = Date.now(), recovering: boolean = false, expectedJournal?: PairingJournal,
  canCommit?: () => boolean): Promise<void> {
  return mutateHost(async (): Promise<void> => {
    let removedAt = hostRemovalTimestamp(context, meta.id);
    if (pairingStartedAt <= hostPairingCancellationTimestamp(context, meta.id)) { throw new Error('Pairing was cancelled'); }
    if (!Number.isSafeInteger(pairingStartedAt) || pairingStartedAt < 0 || (removedAt > 0 && pairingStartedAt <= removedAt)) { throw new Error('Pairing was superseded by desktop removal'); }
    let prefs = await loadPrefs(context);
    let lastPairing = prefs.getSync(`paired.${meta.id}`, 0) as number;
    let cleanupKey = `${CLEANUP_PREFIX}${meta.id}`;
    let pendingCleanup = prefs.getSync(cleanupKey, false) === true;
    if (pairingStartedAt < lastPairing || (recovering && pairingStartedAt === 0)) { throw new Error('Pairing was superseded by a newer pairing'); }
    let heldJournal = expectedJournal ? await readHostPairingJournal(context, meta.id) : null;
    if (expectedJournal && (heldJournal?.cancelled === true || expectedJournal.startedAt !== pairingStartedAt
      || !matchesPairingJournal(heldJournal, expectedJournal))) {
      throw new Error('Pairing journal was superseded');
    }
    let key = base64DecodeCanonical(meta.publicKeyB64);
    if (!key || key.length !== 32 || meta.id !== hostIdFromKey(meta.publicKeyB64)
      || !isDirectEndpoint(meta.endpoint) || !meta.name || meta.name.length > 1024 || !deviceToken) {
      throw new Error('Invalid paired host');
    }
    let hosts = await readHostList(context);
    let at = hosts.findIndex((host: HostMeta): boolean => host.id === meta.id);
    let oldToken = at >= 0 ? await getDeviceToken(context, meta.id) : null;
    let oldRelay = at >= 0 ? await getRelayCredential(context, meta.id) : null;
    if (meta.relay) { readRelayEndpoint(meta.relay, meta.publicKeyB64); }
    if (relayCredential) { readRelayCredential(relayCredential); }
    if (at >= 0) {
      let previous = hosts[at]; meta.machineName = meta.machineName ?? meta.name;
      if (previous.personalName) { meta.personalName = previous.personalName; meta.name = previous.personalName; }
      hosts[at] = meta;
    } else { meta.machineName = meta.machineName ?? meta.name; hosts.push(meta); }
    if (canCommit && !canCommit()) { throw new Error('Pairing was cancelled'); }
    if (pendingCleanup) {
      await clearRemovedHostPageStorage(context, meta.id);
      await clearRemovedHostPairingJournal(context, meta.id, removedAt);
      if (canCommit && !canCommit()) { throw new Error('Pairing was cancelled'); }
    }
    await putToken(meta.id, deviceToken);
    try {
      if (relayCredential) { await putRelayCredential(meta.id, relayCredential); }
      else if (!meta.relay || at < 0) { await removeRelayCredential(meta.id); }
      await writeHostList(context, hosts, (): void => {
        if ((canCommit && !canCommit()) || pairingStartedAt <= hostPairingCancellationTimestamp(context, meta.id)) {
          throw new Error('Pairing was cancelled');
        }
        prefs.putSync(`paired.${meta.id}`, pairingStartedAt);
        if (pendingCleanup) { prefs.deleteSync(cleanupKey); }
      });
    }
    catch (e) {
      prefs.putSync(`paired.${meta.id}`, lastPairing);
      if (pendingCleanup) { prefs.putSync(cleanupKey, true); }
      if (oldToken === null) { await removeToken(meta.id); } else { await putToken(meta.id, oldToken); }
      if (oldRelay) { await putRelayCredential(meta.id, oldRelay); } else { await removeRelayCredential(meta.id); }
      throw e as Error;
    }
    if (pendingCleanup) { notifyCleanupChanged(); }
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
    let prefs = await loadPrefs(context);
    let previousHosts = prefs.getSync(PREFS_KEY, '[]') as string;
    let remaining = parseHosts(previousHosts).filter((host: HostMeta): boolean => host.id !== hostId);
    let removalKey = `removed.${hostId}`;
    let cleanupKey = `${CLEANUP_PREFIX}${hostId}`;
    let previousRemoval = prefs.getSync(removalKey, 0) as number;
    let previousCleanup = prefs.getSync(cleanupKey, false) === true;
    let pairedAt = prefs.getSync(`paired.${hostId}`, 0) as number;
    try {
      prefs.putSync(PREFS_KEY, JSON.stringify(remaining));
      prefs.putSync(removalKey, Math.max(previousRemoval, pairedAt, Date.now()));
      prefs.putSync(cleanupKey, true);
      prefs.flushSync();
    }
    catch (e) {
      prefs.putSync(PREFS_KEY, previousHosts);
      prefs.putSync(removalKey, previousRemoval);
      if (!previousCleanup) { prefs.deleteSync(cleanupKey); }
      throw e as Error;
    }
    notifyCleanupChanged();
  });
}

async function clearRemovedHostPageStorage(context: common.Context, hostId: string): Promise<void> {
  clearHomeResume(context, hostId);
  await deletePageStorage(context, hostId);
}

async function clearRemovedHostPairingJournal(context: common.Context, hostId: string, removedAt: number): Promise<void> {
  let journal = await readHostPairingJournal(context, hostId);
  if (!journal || journal.startedAt <= removedAt) { await clearHostPairingJournalUnlocked(context, hostId); }
}

function startPendingHostCredentialCleanup(context: common.Context, onlyHostId?: string): Promise<void> {
  let requestKey = onlyHostId ?? '';
  let existing = cleanupRequests.get(requestKey);
  if (existing) { return existing; }
  let request = mutateHost(async (): Promise<void> => {
    let prefs = await loadPrefs(context);
    let hosts = parseHosts(prefs.getSync(PREFS_KEY, '[]') as string);
    for (let hostId of pendingCleanupIds(prefs)) {
      if (onlyHostId !== undefined && hostId !== onlyHostId) { continue; }
      let cleanupKey = `${CLEANUP_PREFIX}${hostId}`;
      try {
        if (!hosts.some((host: HostMeta): boolean => host.id === hostId)) {
          let removedAt = prefs.getSync(`removed.${hostId}`, 0) as number;
          let pairedAt = prefs.getSync(`paired.${hostId}`, 0) as number;
          if (!Number.isSafeInteger(removedAt) || removedAt <= 0 || pairedAt > removedAt) { continue; }
          await clearRemovedHostPairingJournal(context, hostId, removedAt);
          await removeToken(hostId);
          await removeRelayCredential(hostId);
          await clearRemovedHostPageStorage(context, hostId);
        }
        prefs.deleteSync(cleanupKey);
        try { prefs.flushSync(); } catch (e) { prefs.putSync(cleanupKey, true); throw e as Error; }
        notifyCleanupChanged();
      } catch (e) { }
    }
  }).finally((): void => { cleanupRequests.delete(requestKey); });
  cleanupRequests.set(requestKey, request);
  return request;
}

export async function retryPendingHostCredentialCleanup(context: common.Context, onlyHostId?: string): Promise<HostCredentialCleanupState> {
  let timer = -1;
  try {
    let request = startPendingHostCredentialCleanup(context, onlyHostId);
    // Keep the mutation held until the native delete settles, even when Settings stops waiting.
    await new Promise<void>((resolve, reject): void => {
      timer = setTimeout(resolve, CLEANUP_CONFIRM_MS);
      request.then(resolve, reject);
    });
    return await loadPendingHostCredentialCleanup(context);
  } catch (e) { return { count: 0, storageUnreadable: true }; }
  finally { if (timer >= 0) { clearTimeout(timer); } }
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

export async function updateHostNameAndEndpoint(context: common.Context, hostId: string, personalName?: string,
  endpoint?: string): Promise<boolean> {
  let endpointChanged = false;
  await mutateHost(async (): Promise<void> => {
    let name = personalName?.trim(); let address = endpoint?.trim();
    if (!/^[a-f0-9]{32}$/.test(hostId) || (name !== undefined && (name.length > 1024 || /[\x00-\x1f]/.test(name)))
      || (address !== undefined && !isDirectEndpoint(address))) { throw new Error('Invalid desktop name or endpoint'); }
    let hosts = await readHostList(context);
    let host = hosts.find((item: HostMeta): boolean => item.id === hostId);
    if (!host) { throw new Error('Desktop was removed'); }
    endpointChanged = address !== undefined && address !== host.endpoint;
    let machineName = host.machineName ?? (!host.personalName ? host.name : '');
    host.machineName = machineName;
    if (name !== undefined) { host.personalName = name; }
    host.endpoint = address ?? host.endpoint;
    host.name = host.personalName || machineName || host.endpoint;
    await writeHostList(context, hosts);
  });
  return endpointChanged;
}

export function updateHostMachine(context: common.Context, paired: HostMeta, descriptor: HostMachineDescriptor): Promise<void> {
  return mutateHost(async (): Promise<void> => {
    let hosts = await readHostList(context);
    let host = hosts.find((item: HostMeta): boolean => item.id === paired.id);
    // A status from a replaced pairing or edited address cannot write to its successor.
    if (!host || host.lastConnected !== paired.lastConnected || host.endpoint !== paired.endpoint) { return; }
    if (host.hostPlatform === descriptor.hostPlatform && host.hostMachine?.kind === descriptor.hostMachine?.kind
      && host.hostMachine?.model === descriptor.hostMachine?.model) { return; }
    host.hostPlatform = descriptor.hostPlatform; host.hostMachine = descriptor.hostMachine;
    await writeHostList(context, hosts);
  });
}

export function hostRemovalTimestamp(context: common.Context, hostId: string): number {
  let prefs = preferences.getPreferencesSync(context, { name: PREFS_NAME });
  return prefs.getSync(`removed.${hostId}`, 0) as number;
}

export function hostPairingTimestamp(context: common.Context, hostId: string): number {
  let prefs = preferences.getPreferencesSync(context, { name: PREFS_NAME });
  return prefs.getSync(`paired.${hostId}`, 0) as number;
}

function pairingPrefs(context: common.Context): preferences.Preferences {
  return preferences.getPreferencesSync(context, { name: PAIRING_PREFS_NAME });
}

export function hostPairingCancellationTimestamp(context: common.Context, hostId: string): number {
  return pairingPrefs(context).getSync(`cancelled.${hostId}`, 0) as number;
}

export function cancelHostPairing(context: common.Context, hostId: string, startedAt: number): void {
  let prefs = pairingPrefs(context);
  let key = `cancelled.${hostId}`;
  let previous = prefs.getSync(key, 0) as number;
  if (startedAt <= previous) { return; }
  try { prefs.putSync(key, startedAt); prefs.flushSync(); }
  catch (e) { prefs.putSync(key, previous); throw e as Error; }
}

function pendingPairingIds(prefs: preferences.Preferences): string[] {
  let ids = JSON.parse(prefs.getSync(PAIRING_PENDING_KEY, '[]') as string) as string[];
  if (!Array.isArray(ids)) { throw new Error('Invalid pairing journal index'); }
  return Array.from(new Set(ids.filter((id: string): boolean => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id))));
}

export function listHostPairingJournals(context: common.Context): string[] {
  return pendingPairingIds(pairingPrefs(context));
}

function persistPendingPairingIds(prefs: preferences.Preferences, ids: string[]): void {
  let previous = prefs.getSync(PAIRING_PENDING_KEY, '[]');
  try { prefs.putSync(PAIRING_PENDING_KEY, JSON.stringify(ids)); prefs.flushSync(); }
  catch (e) { prefs.putSync(PAIRING_PENDING_KEY, previous); throw e as Error; }
}

function legacyPairingQuery(hostId: string): asset.AssetMap {
  let query: asset.AssetMap = new Map();
  query.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(`orca.relay.pair.${hostId}`));
  return query;
}

function assertPairingJournal(hostId: string, journal: PairingJournal): void {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
    || !Number.isSafeInteger(journal.startedAt) || journal.startedAt < 0
    || typeof journal.reqId !== 'string' || journal.reqId.length < 1 || journal.reqId.length > 128
    || typeof journal.offerKey !== 'string' || hostIdFromKey(journal.offerKey) !== hostId
    || typeof journal.token !== 'string' || !journal.token || typeof journal.hash !== 'string' || !journal.hash
    || typeof journal.deviceToken !== 'string' || !journal.deviceToken
    || (journal.cancelled !== undefined && typeof journal.cancelled !== 'boolean')
    || (journal.replacementToken !== undefined && !/^[a-f0-9]{48}$/.test(journal.replacementToken))
    || (journal.draft !== undefined && (journal.draft?.id !== hostId || journal.draft?.publicKeyB64 !== journal.offerKey))
    || (journal.committedMeta !== undefined
      && (journal.committedMeta?.id !== hostId || journal.committedMeta?.publicKeyB64 !== journal.offerKey))) {
    throw new Error('Invalid pairing journal');
  }
}

function matchesPairingJournal(held: PairingJournal | null, expected: PairingJournal): boolean {
  return held !== null && held.startedAt === expected.startedAt && held.reqId === expected.reqId;
}

export async function readHostPairingJournal(context: common.Context, hostId: string): Promise<PairingJournal | null> {
  let rows = new DeviceRowStore(context, hostId);
  let text = await rows.readPairingJournal();
  if (text === null) {
    let query = legacyPairingQuery(hostId); query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      let found = await asset.query(query);
      if (found.length === 0) { return null; }
      text = utf8Decode(found[0].get(asset.Tag.SECRET) as Uint8Array);
    } catch (e) {
      if ((e as BusinessError).code === asset.ErrorCode.NOT_FOUND) { return null; }
      throw e as Error;
    }
  }
  let journal: PairingJournal;
  try { journal = JSON.parse(text) as PairingJournal; }
  catch (e) { throw new Error('Invalid pairing journal'); }
  assertPairingJournal(hostId, journal);
  return journal;
}

export function writeHostPairingJournal(context: common.Context, hostId: string, journal: PairingJournal,
  expected?: PairingJournal): Promise<void> {
  return mutateHost(async (): Promise<void> => {
    assertPairingJournal(hostId, journal);
    if (!journal.cancelled && journal.startedAt <= hostPairingCancellationTimestamp(context, hostId)) { throw new Error('Pairing was cancelled'); }
    let removedAt = hostRemovalTimestamp(context, hostId);
    if (removedAt > 0 && journal.startedAt <= removedAt) { throw new Error('Pairing was superseded by desktop removal'); }
    let held = await readHostPairingJournal(context, hostId);
    let lastPairing = hostPairingTimestamp(context, hostId);
    if (held?.cancelled && journal.startedAt <= held.startedAt && !journal.cancelled) { throw new Error('Pairing was cancelled'); }
    if (expected) {
      let replacesHeld = journal.startedAt > expected.startedAt && journal.startedAt > lastPairing;
      if (journal.startedAt < lastPairing || !matchesPairingJournal(held, expected)
        || (!matchesPairingJournal(journal, expected) && !replacesHeld)) { throw new Error('Pairing journal was superseded'); }
    } else if ((lastPairing > 0 && journal.startedAt <= lastPairing) || (held && journal.startedAt <= held.startedAt)) {
      throw new Error('Pairing journal was superseded');
    }
    let prefs = pairingPrefs(context);
    let ids = pendingPairingIds(prefs);
    if (!ids.includes(hostId)) { ids.push(hostId); persistPendingPairingIds(prefs, ids); }
    await new DeviceRowStore(context, hostId).writePairingJournal(JSON.stringify(journal));
  });
}

async function clearHostPairingJournalUnlocked(context: common.Context, hostId: string): Promise<void> {
  let rows = new DeviceRowStore(context, hostId);
  let query = legacyPairingQuery(hostId);
  // Removing the fallback first prevents a crash during cleanup from restoring an old journal.
  try { await asset.remove(query); }
  catch (e) { if ((e as BusinessError).code !== asset.ErrorCode.NOT_FOUND) { throw e as Error; } }
  await rows.deletePairingJournal();
  let prefs = pairingPrefs(context);
  let ids = pendingPairingIds(prefs);
  if (ids.includes(hostId)) { persistPendingPairingIds(prefs, ids.filter((id: string): boolean => id !== hostId)); }
}

export function clearHostPairingJournal(context: common.Context, hostId: string, expected?: PairingJournal): Promise<void> {
  return mutateHost(async (): Promise<void> => {
    if (expected) {
      let held = await readHostPairingJournal(context, hostId);
      if (held && !matchesPairingJournal(held, expected)) { return; }
    }
    await clearHostPairingJournalUnlocked(context, hostId);
  });
}
