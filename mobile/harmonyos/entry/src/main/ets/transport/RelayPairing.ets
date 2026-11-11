import { common } from '@kit.AbilityKit';
import { PairingOffer } from './E2eeV2Session';
import { SpikeRpcClient, RpcSuccess } from './SpikeRpcClient';
import { PairingRelay, RelayEndpoint, RelayCredential, RelayMove, readRelayEndpoint, relayBase64Url, relayCredentialHash } from './RelayProtocol';
import { PairingConnection, PairingConnectionResult, exchangePairingTicket, RELAY_PAIRING_CREDENTIAL_REJECTED } from '../pairing/PairingConnection';
import { randomBytes } from './crypto/Bytes';
import { HostMeta, PairingJournal, hostIdFor, saveHost, hostRemovalTimestamp, hostPairingTimestamp,
  readHostPairingJournal, writeHostPairingJournal, hostPairingCancellationTimestamp, cancelHostPairing, clearHostPairingJournal, listHostPairingJournals } from '../storage/HostStore';

const RECOVERY_GRACE_MS = 10 * 60 * 1000;
const RECOVERY_TIMEOUT_MS = 25000;
const RPC_TIMEOUT_MS = 8000;
const activePairings = new Map<string, number>();
const cancelledPairings = new Map<string, number>();
let recovering: Promise<string[]> | null = null;

interface InstalledCredential {
  version: number;
  expiresAt: number;
  authorizationMode: string;
  graceExpiresAt?: number;
}
interface InstallStatus {
  endpoint: RelayEndpoint;
  state: string;
  installed?: InstalledCredential;
  confirmation?: ESObject;
}
export interface RelayPairingPrepared {
  endpoint: RelayEndpoint;
  credential: RelayCredential;
  journal: PairingJournal;
}

function assertPairingActive(isActive: () => boolean): void {
  if (!isActive()) { throw new Error('Pairing was cancelled'); }
}

export async function beginRelayPairing(context: common.Context, offer: PairingOffer, startedAt: number,
  isActive: () => boolean): Promise<PairingJournal | null> {
  let relay = offer.relay;
  let hostId = hostIdFor(offer.publicKeyB64);
  if (activePairings.has(hostId)) { throw new Error('Pairing is already in progress'); }
  activePairings.set(hostId, startedAt);
  try {
    let previous = await readHostPairingJournal(context, hostId);
    assertPairingActive(isActive);
    let reuse = previous && !previous.committedMeta && previous.startedAt > hostRemovalTimestamp(context, hostId)
      && previous.startedAt >= hostPairingTimestamp(context, hostId)
      && previous.offerKey === offer.publicKeyB64 && previous.deviceToken === offer.deviceToken
      && (!previous.relay || previous.relay.inviteToken === relay?.inviteToken);
    let token = reuse && previous ? previous.token : relayBase64Url(randomBytes(32));
    let reqId = reuse && previous ? previous.reqId : `install-${relayBase64Url(randomBytes(16))}`;
    if (reuse && previous?.relay && relay && previous.relay.assignmentEpoch > relay.assignmentEpoch) { relay = previous.relay; }
    let draft: HostMeta = { id: hostId, name: offer.endpoint, endpoint: offer.endpoint, publicKeyB64: offer.publicKeyB64,
      lastConnected: startedAt };
    let journal: PairingJournal = { startedAt: startedAt, reqId: reqId, token: token, hash: relayCredentialHash(token),
      offerKey: offer.publicKeyB64, deviceToken: offer.deviceToken, draft: draft, relay: relay,
      replacementToken: reuse && previous ? previous.replacementToken : undefined };
    await writeHostPairingJournal(context, hostId, journal, previous ?? undefined);
    return journal;
  } catch (e) {
    finishRelayPairing(hostId, startedAt); throw e as Error;
  }
}

export async function cancelRelayPairing(context: common.Context, hostId: string, startedAt: number): Promise<void> {
  cancelledPairings.set(hostId, Math.max(startedAt, cancelledPairings.get(hostId) ?? 0));
  cancelHostPairing(context, hostId, startedAt);
  let journal = await readHostPairingJournal(context, hostId);
  if (!journal || journal.startedAt !== startedAt) { return; }
  journal.cancelled = true;
  await writeHostPairingJournal(context, hostId, journal, journal);
}

export async function exchangeJournalTicket(context: common.Context, journal: PairingJournal,
  connection: PairingConnectionResult, log: (line: string) => void, isActive: () => boolean): Promise<string> {
  return exchangePairingTicket(connection, journal.deviceToken, log, async (token: string): Promise<void> => {
    assertPairingActive(isActive);
    journal.replacementToken = token;
    await writeHostPairingJournal(context, hostIdFor(journal.offerKey), journal, journal);
    assertPairingActive(isActive);
  }, journal.replacementToken);
}

export function finishRelayPairing(hostId: string, startedAt: number): void {
  if (activePairings.get(hostId) === startedAt) { activePairings.delete(hostId); }
}

export async function rememberRelayPairingMove(context: common.Context, journal: PairingJournal, move: RelayMove,
  isActive: () => boolean): Promise<void> {
  let relay = journal.relay;
  if (!relay || move.assignmentEpoch <= relay.assignmentEpoch) { return; }
  assertPairingActive(isActive);
  let next: PairingRelay = { v: relay.v, directorUrl: relay.directorUrl, cellUrl: move.cellUrl,
    assignmentEpoch: move.assignmentEpoch, relayHostId: relay.relayHostId, e2eeFraming: relay.e2eeFraming,
    inviteToken: relay.inviteToken, inviteExpiresAt: relay.inviteExpiresAt };
  journal.relay = next;
  await writeHostPairingJournal(context, hostIdFor(journal.offerKey), journal, journal);
}

function readInstalled(raw: ESObject, reqId: string): InstalledCredential {
  if (!raw || raw['v'] !== 1 || raw['reqId'] !== reqId || !Number.isSafeInteger(raw['currentVersion'])
    || raw['currentVersion'] < 1 || !Number.isSafeInteger(raw['resumeExpiresAt']) || raw['resumeExpiresAt'] < 0
    || !['relay-basis', 'authenticated-direct'].includes(raw['authorizationMode'])) {
    throw new Error('Invalid relay credential installation result');
  }
  return { version: raw['currentVersion'], expiresAt: raw['resumeExpiresAt'], authorizationMode: raw['authorizationMode'],
    graceExpiresAt: raw['graceExpiresAt'] };
}

function readStatus(reply: RpcSuccess, journal: PairingJournal): InstallStatus | null {
  let result: ESObject = JSON.parse(reply.result);
  let status: ESObject = result?.['installStatus'];
  if (!status) { return null; }
  if (result['v'] !== 1 || status['v'] !== 1 || status['reqId'] !== journal.reqId ||
    !['committed', 'not-found'].includes(status['state'])) { throw new Error('Invalid relay installation status'); }
  let endpoint = readRelayEndpoint(result['relay'], journal.offerKey);
  let relay = journal.relay;
  if (relay && (endpoint.assignmentEpoch < relay.assignmentEpoch ||
    (endpoint.assignmentEpoch === relay.assignmentEpoch && endpoint.cellUrl !== relay.cellUrl))) {
    throw new Error('Relay endpoint was superseded');
  }
  return { endpoint: endpoint, state: status['state'],
    installed: status['state'] === 'committed' ? readInstalled(status['result'], journal.reqId) : undefined,
    confirmation: result['resumeConfirmation'] };
}

function sameInstall(left: InstalledCredential, right: InstalledCredential): boolean {
  return left.version === right.version && left.expiresAt === right.expiresAt
    && left.authorizationMode === right.authorizationMode && left.graceExpiresAt === right.graceExpiresAt;
}

function prepared(journal: PairingJournal, status: InstallStatus, expiresAt?: number): RelayPairingPrepared {
  let installed = status.installed;
  if (!installed || (expiresAt ?? installed.expiresAt) <= Date.now()) { throw new Error('Relay install is not current'); }
  let credential: RelayCredential = { token: journal.token, hash: journal.hash, version: installed.version,
    expiresAt: expiresAt ?? installed.expiresAt };
  return { endpoint: status.endpoint, credential: credential, journal: journal };
}

async function provision(client: SpikeRpcClient, journal: PairingJournal, isActive: () => boolean): Promise<InstallStatus | null> {
  assertPairingActive(isActive);
  let params: Record<string, string> = { 'reqId': journal.reqId, 'newResumeTokenHash': journal.hash };
  let reply = await client.request('pairing.provisionRelay', JSON.stringify(params), RPC_TIMEOUT_MS);
  assertPairingActive(isActive);
  if (!(reply instanceof RpcSuccess)) {
    if (!client.isRelay() && ['unknown_method', 'method_not_found', 'not_supported', 'relay_unavailable', 'forbidden'].includes(reply.errorCode)) {
      return null;
    }
    throw new Error('Relay credential installation is unresolved');
  }
  let installed = readInstalled(JSON.parse(reply.result), journal.reqId);
  let query: Record<string, string> = { 'installReqId': journal.reqId };
  let response = await client.request('pairing.getEndpoints', JSON.stringify(query), RPC_TIMEOUT_MS);
  assertPairingActive(isActive);
  let status = response instanceof RpcSuccess ? readStatus(response, journal) : null;
  if (!status || !status.installed || !sameInstall(status.installed, installed)) {
    throw new Error('Relay credential installation is not confirmed');
  }
  return status;
}

export async function prepareRelayPairing(context: common.Context, journal: PairingJournal | null, meta: HostMeta,
  client: SpikeRpcClient, isActive: () => boolean): Promise<RelayPairingPrepared | null> {
  if (!journal?.relay) { return null; }
  assertPairingActive(isActive);
  journal.draft = meta;
  await writeHostPairingJournal(context, meta.id, journal, journal);
  assertPairingActive(isActive);
  let query: Record<string, string> = { 'installReqId': journal.reqId };
  let reply = await client.request('pairing.getEndpoints', JSON.stringify(query), RPC_TIMEOUT_MS);
  assertPairingActive(isActive);
  let status = reply instanceof RpcSuccess ? readStatus(reply, journal) : null;
  if (!status?.installed) { status = await provision(client, journal, isActive); }
  if (!status) { return null; }
  return prepared(journal, status);
}

export async function commitRelayPairing(context: common.Context, meta: HostMeta, deviceToken: string,
  relayPairing: RelayPairingPrepared, isActive: () => boolean): Promise<void> {
  assertPairingActive(isActive);
  let journal = relayPairing.journal;
  meta.relay = relayPairing.endpoint;
  let committed: PairingJournal = { startedAt: journal.startedAt, reqId: journal.reqId, token: journal.token,
    hash: journal.hash, offerKey: journal.offerKey, deviceToken: deviceToken, committedMeta: meta, credential: relayPairing.credential };
  await writeHostPairingJournal(context, meta.id, committed, journal);
  assertPairingActive(isActive);
  await publishCommitted(context, committed, isActive);
}

export async function commitConnectedPairing(context: common.Context, journal: PairingJournal, meta: HostMeta,
  connection: PairingConnectionResult, log: (line: string) => void, isActive: () => boolean): Promise<void> {
  assertPairingActive(isActive);
  journal.draft = meta;
  let token = await exchangeJournalTicket(context, journal, connection, log, isActive);
  assertPairingActive(isActive);
  let relayPairing = await prepareRelayPairing(context, journal, meta, connection.client, isActive);
  assertPairingActive(isActive);
  if (relayPairing) { await commitRelayPairing(context, meta, token, relayPairing, isActive); }
  else {
    await saveHost(context, meta, token, undefined, journal.startedAt, false, journal, isActive);
    await clearHostPairingJournal(context, meta.id, journal).catch(() => {});
  }
}

async function publishCommitted(context: common.Context, journal: PairingJournal, isActive?: () => boolean): Promise<void> {
  let meta = journal.committedMeta;
  let credential = journal.credential;
  if (!meta || !credential) { throw new Error('Relay journal is missing the committed credential'); }
  await saveHost(context, meta, journal.deviceToken, credential, journal.startedAt, true, journal, isActive);
  // A later startup may clean up the journal if only this deletion failed.
  await clearHostPairingJournal(context, meta.id, journal).catch(() => {});
}

async function resumeInstall(client: SpikeRpcClient, journal: PairingJournal, observeCommitted: () => void): Promise<RelayPairingPrepared | null> {
  // A resume confirmation is bound to this socket's basis connection, not the install request.
  let confirmId = `confirm-${relayBase64Url(randomBytes(16))}`;
  let query: Record<string, string> = { 'installReqId': journal.reqId, 'resumeConfirmReqId': confirmId };
  let reply = await client.request('pairing.getEndpoints', JSON.stringify(query), RPC_TIMEOUT_MS);
  let status = reply instanceof RpcSuccess ? readStatus(reply, journal) : null;
  if (!status?.installed) { return null; }
  observeCommitted();
  let proof: ESObject = status.confirmation;
  if (!proof || proof['v'] !== 1 || proof['reqId'] !== confirmId || proof['acceptedAs'] !== 'current'
    || proof['currentVersion'] !== client.getRelayAcceptedVersion() || proof['currentVersion'] !== status.installed.version
    || typeof proof['renewed'] !== 'boolean' || !Number.isSafeInteger(proof['resumeExpiresAt'])
    || proof['resumeExpiresAt'] <= Date.now()) { throw new Error('Invalid relay pairing resume confirmation'); }
  return prepared(journal, status, proof['resumeExpiresAt']);
}

async function inviteInstall(client: SpikeRpcClient, journal: PairingJournal,
  isActive: () => boolean, observeCommitted: () => void): Promise<RelayPairingPrepared | null> {
  let query: Record<string, string> = { 'installReqId': journal.reqId };
  let reply = await client.request('pairing.getEndpoints', JSON.stringify(query), RPC_TIMEOUT_MS);
  assertPairingActive(isActive);
  let status = reply instanceof RpcSuccess ? readStatus(reply, journal) : null;
  if (status?.state === 'not-found') { status = await provision(client, journal, isActive); }
  if (!status?.installed) { return null; }
  observeCommitted();
  return prepared(journal, status);
}

async function recoverPending(context: common.Context, journal: PairingJournal, meta: HostMeta, relay: PairingRelay): Promise<boolean> {
  let offer: PairingOffer = { endpoint: meta.endpoint, deviceToken: journal.deviceToken, publicKeyB64: journal.offerKey,
    scope: '', hasRelay: true, relay: relay };
  let timedOut = false;
  let attempt: PairingConnection | null = null;
  let deadline = setTimeout((): void => { timedOut = true; attempt?.close(); }, RECOVERY_TIMEOUT_MS);
  let isActive = (): boolean => !timedOut && !activePairings.has(meta.id)
    && (cancelledPairings.get(meta.id) ?? 0) < journal.startedAt && journal.cancelled !== true
    && hostPairingCancellationTimestamp(context, meta.id) < journal.startedAt
    && journal.startedAt > hostRemovalTimestamp(context, meta.id) && journal.startedAt > hostPairingTimestamp(context, meta.id);
  let kinds = relay.inviteExpiresAt > Date.now() ? ['resume', 'invite'] : ['resume'];
  let refused = 0;
  let observedCommitted = false;
  let observeCommitted = (): void => { observedCommitted = true; };
  try {
    for (let kind of kinds) {
      if (!isActive()) { return false; }
      let connection = new PairingConnection();
      attempt = connection;
      let recovered: RelayPairingPrepared | null = null;
      let recoveredDeviceToken = journal.deviceToken;
      try {
        let latest = journal.relay ?? relay;
        let client = await connection.connectRecoveryRelay(offer, latest, kind, kind === 'resume' ? journal.token : relay.inviteToken,
          (move: RelayMove): Promise<void> => rememberRelayPairingMove(context, journal, move, isActive));
        assertPairingActive(isActive);
        let reply = await client.request('status.get', null, RPC_TIMEOUT_MS);
        if (!(reply instanceof RpcSuccess)) { throw new Error('Desktop status unavailable'); }
        let status = JSON.parse(reply.result) as Record<string, Object>;
        recoveredDeviceToken = await exchangeJournalTicket(context, journal, { client: client, status: status }, (): void => {}, isActive);
        recovered = kind === 'resume' ? await resumeInstall(client, journal, observeCommitted)
          : await inviteInstall(client, journal, isActive, observeCommitted);
      } catch (e) {
        if ((e as Error).message === RELAY_PAIRING_CREDENTIAL_REJECTED) { refused++; }
      } finally { connection.close(); attempt = null; }
      if (recovered) {
        await commitRelayPairing(context, meta, recoveredDeviceToken, recovered, isActive);
        return true;
      }
    }
    if (isActive() && !observedCommitted && (refused === kinds.length || relay.inviteExpiresAt + RECOVERY_GRACE_MS <= Date.now())) {
      await clearHostPairingJournal(context, meta.id, journal);
    }
    return false;
  } finally { clearTimeout(deadline); }
}

async function recoverHost(context: common.Context, id: string): Promise<boolean> {
  if (activePairings.has(id)) { return false; }
  let journal = await readHostPairingJournal(context, id);
  if (activePairings.has(id)) { return false; }
  if (!journal || journal.cancelled || (cancelledPairings.get(id) ?? 0) >= journal.startedAt
    || hostPairingCancellationTimestamp(context, id) >= journal.startedAt) { return false; }
  if (journal.startedAt <= hostRemovalTimestamp(context, id) || journal.startedAt <= hostPairingTimestamp(context, id)) {
    await clearHostPairingJournal(context, id, journal); return false;
  }
  if (hostIdFor(journal.offerKey) !== id || journal.hash !== relayCredentialHash(journal.token)) { return false; }
  if (journal.committedMeta && journal.credential) {
    if (journal.committedMeta.id !== id) { return false; }
    let startedAt = journal.startedAt;
    await publishCommitted(context, journal, (): boolean => !activePairings.has(id)
      && (cancelledPairings.get(id) ?? 0) < startedAt
      && hostPairingCancellationTimestamp(context, id) < startedAt);
    return true;
  }
  let draft = journal.draft;
  let relay = journal.relay;
  if (!draft || draft.id !== id || draft.publicKeyB64 !== journal.offerKey || !relay) { return false; }
  return recoverPending(context, journal, draft, relay);
}

export function recoverRelayPairings(context: common.Context): Promise<string[]> {
  if (recovering) { return recovering; }
  recovering = Promise.resolve().then(async (): Promise<string[]> => {
    let ids = listHostPairingJournals(context);
    let restored: string[] = [];
    for (let id of ids) {
      try { if (await recoverHost(context, id)) { restored.push(id); } }
      catch (e) { }
    }
    return restored;
  }).finally((): void => { recovering = null; });
  return recovering;
}
