import { common } from '@kit.AbilityKit';
import { asset } from '@kit.AssetStoreKit';
import { preferences } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { PairingOffer } from './E2eeV2Session';
import { SpikeRpcClient, RpcSuccess } from './SpikeRpcClient';
import { RelayEndpoint, RelayCredential, readRelayEndpoint, relayBase64Url, relayCredentialHash } from './RelayProtocol';
import { randomBytes, utf8Encode, utf8Decode } from './crypto/Bytes';
import { HostMeta, hostIdFor, saveHost, hostRemovalTimestamp, clearHostPairingJournal } from '../storage/HostStore';

export interface RelayPairingPrepared { endpoint: RelayEndpoint; credential: RelayCredential; journalId: string; startedAt: number; }
interface PairingJournal { startedAt: number; reqId: string; token: string; hash: string; offerKey: string; deviceToken: string; committedMeta?: HostMeta; credential?: RelayCredential; }
async function readJournal(hostId: string): Promise<PairingJournal | null> {
  let query: asset.AssetMap = new Map(); query.set(asset.Tag.ALIAS, utf8Encode(`orca.relay.pair.${hostId}`));
  query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
  try {
    let found = await asset.query(query);
    if (!found.length) { return null; }
    return JSON.parse(utf8Decode(found[0].get(asset.Tag.SECRET) as Uint8Array)) as PairingJournal;
  } catch (e) { if ((e as BusinessError).code === asset.ErrorCode.NOT_FOUND) { return null; } throw e as Error; }
}
async function writeJournal(context: common.Context, hostId: string, journal: PairingJournal): Promise<void> {
  if (!Number.isSafeInteger(journal.startedAt) || (hostRemovalTimestamp(context, hostId) > 0 && journal.startedAt <= hostRemovalTimestamp(context, hostId))) {
    throw new Error('Pairing was superseded by desktop removal');
  }
  let held = await readJournal(hostId);
  if (held && Number.isSafeInteger(held.startedAt) && held.startedAt > journal.startedAt) { throw new Error('Pairing journal was superseded'); }
  let alias = utf8Encode(`orca.relay.pair.${hostId}`); let encoded = utf8Encode(JSON.stringify(journal));
  let secret: asset.AssetMap = new Map(); secret.set(asset.Tag.ALIAS, alias); secret.set(asset.Tag.SECRET, encoded);
  try { await asset.add(secret); }
  catch (e) {
    if ((e as BusinessError).code !== asset.ErrorCode.DUPLICATED) { throw e as Error; }
    let query: asset.AssetMap = new Map(); query.set(asset.Tag.ALIAS, alias);
    let update: asset.AssetMap = new Map(); update.set(asset.Tag.SECRET, encoded); await asset.update(query, update);
  }
  let prefs = preferences.getPreferencesSync(context, { name: 'orca_relay_pairing' });
  let ids = JSON.parse(prefs.getSync('pending', '[]') as string) as string[];
  if (!ids.includes(hostId)) { ids.push(hostId); prefs.putSync('pending', JSON.stringify(ids)); prefs.flushSync(); }
}
async function clearJournal(context: common.Context, hostId: string): Promise<void> {
  await clearHostPairingJournal(context, hostId);
}

function assertPairingActive(isActive: () => boolean): void {
  if (!isActive()) { throw new Error('Pairing was cancelled'); }
}

export async function prepareRelayPairing(context: common.Context, offer: PairingOffer, client: SpikeRpcClient, pairingStartedAt: number = Date.now(), isActive: () => boolean = (): boolean => true): Promise<RelayPairingPrepared | null> {
  assertPairingActive(isActive);
  if (!offer.relay) { return null; }
  let hostId = hostIdFor(offer.publicKeyB64);
  let journal = await readJournal(hostId);
  assertPairingActive(isActive);
  if (!journal || journal.offerKey !== offer.publicKeyB64 || journal.deviceToken !== offer.deviceToken || journal.committedMeta || !Number.isSafeInteger(journal.startedAt)
    || (hostRemovalTimestamp(context, hostId) > 0 && journal.startedAt <= hostRemovalTimestamp(context, hostId))) {
    let token = relayBase64Url(randomBytes(32));
    journal = { startedAt: pairingStartedAt, reqId: `install-${relayBase64Url(randomBytes(16))}`, token: token, hash: relayCredentialHash(token),
      offerKey: offer.publicKeyB64, deviceToken: offer.deviceToken };
    assertPairingActive(isActive);
    await writeJournal(context, hostId, journal);
    assertPairingActive(isActive);
  }
  let query: Record<string, string> = { 'installReqId': journal.reqId };
  assertPairingActive(isActive);
  let response = await client.request('pairing.getEndpoints', JSON.stringify(query));
  assertPairingActive(isActive);
  let endpointResult: ESObject = response instanceof RpcSuccess ? JSON.parse(response.result) : null;
  let status: ESObject = endpointResult ? endpointResult['installStatus'] : null;
  if (!status || status['state'] !== 'committed') {
    let params: Record<string, string> = { 'reqId': journal.reqId, 'newResumeTokenHash': journal.hash };
    assertPairingActive(isActive);
    let provision = await client.request('pairing.provisionRelay', JSON.stringify(params));
    assertPairingActive(isActive);
    if (!(provision instanceof RpcSuccess)) {
      if (!client.isRelay() && ['unknown_method', 'method_not_found', 'not_supported', 'relay_unavailable', 'forbidden'].includes(provision.errorCode)) {
        await clearJournal(context, hostId); assertPairingActive(isActive); return null;
      }
      throw new Error('Relay credential installation failed; pair again to reconcile');
    }
    let installed: ESObject = JSON.parse(provision.result);
    assertPairingActive(isActive);
    response = await client.request('pairing.getEndpoints', JSON.stringify(query));
    assertPairingActive(isActive);
    if (!(response instanceof RpcSuccess)) { throw new Error('Relay credential installation status unavailable'); }
    endpointResult = JSON.parse(response.result); status = endpointResult['installStatus'];
    if (!status || status['state'] !== 'committed' || JSON.stringify(status['result']) !== JSON.stringify(installed)) {
      throw new Error('Relay credential install was not authoritatively committed');
    }
  }
  let installed: ESObject = status['result'];
  if (!installed || installed['v'] !== 1 || installed['reqId'] !== journal.reqId
    || !Number.isSafeInteger(installed['currentVersion']) || installed['currentVersion'] < 1
    || !Number.isSafeInteger(installed['resumeExpiresAt']) || installed['resumeExpiresAt'] <= Date.now()
    || !['relay-basis', 'authenticated-direct'].includes(installed['authorizationMode'])) {
    throw new Error('Invalid relay credential installation result');
  }
  let endpoint = readRelayEndpoint(endpointResult['relay'], offer.publicKeyB64);
  let credential: RelayCredential = { token: journal.token, hash: journal.hash, version: installed['currentVersion'], expiresAt: installed['resumeExpiresAt'] };
  let prepared: RelayPairingPrepared = { endpoint: endpoint, credential: credential, journalId: hostId, startedAt: journal.startedAt };
  return prepared;
}

export async function commitRelayPairing(context: common.Context, meta: HostMeta, deviceToken: string, prepared: RelayPairingPrepared, isActive: () => boolean = (): boolean => true): Promise<void> {
  assertPairingActive(isActive);
  let journal = await readJournal(meta.id);
  assertPairingActive(isActive);
  if (!journal || journal.token !== prepared.credential.token) { throw new Error('Relay pairing journal changed'); }
  assertPairingActive(isActive);
  meta.relay = prepared.endpoint;
  journal.deviceToken = deviceToken; journal.committedMeta = meta; journal.credential = prepared.credential;
  await writeJournal(context, meta.id, journal);
  await saveHost(context, meta, deviceToken, prepared.credential, prepared.startedAt);
  await clearJournal(context, meta.id);
}

export async function recoverRelayPairings(context: common.Context): Promise<void> {
  let prefs = preferences.getPreferencesSync(context, { name: 'orca_relay_pairing' });
  let ids = JSON.parse(prefs.getSync('pending', '[]') as string) as string[];
  for (let i = 0; i < ids.length; i++) {
    if (!/^[a-f0-9]{32}$/.test(ids[i])) { continue; }
    let journal = await readJournal(ids[i]);
    let removedAt = hostRemovalTimestamp(context, ids[i]);
    if (removedAt > 0 && (!journal || !Number.isSafeInteger(journal.startedAt) || journal.startedAt <= removedAt)) {
      await clearJournal(context, ids[i]); continue;
    }
    if (journal && journal.committedMeta && journal.credential) {
      await saveHost(context, journal.committedMeta, journal.deviceToken, journal.credential, journal.startedAt, true);
      await clearJournal(context, ids[i]);
    }
  }
}
