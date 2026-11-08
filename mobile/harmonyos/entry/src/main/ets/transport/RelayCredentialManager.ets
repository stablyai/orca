import { common } from '@kit.AbilityKit';
import { HostMeta, updateRelayCredential, RelayCredentialFence } from '../storage/HostStore';
import { RelayCredential, RelayEndpoint, readRelayEndpoint, relayBase64Url, relayCredentialHash } from './RelayProtocol';
import { randomBytes } from './crypto/Bytes';
import { SpikeRpcClient, RpcSuccess } from './SpikeRpcClient';

export interface RelayCredentialUpdate { credential: RelayCredential; endpoint: RelayEndpoint; }
function credentialFence(client: SpikeRpcClient, credential: RelayCredential): RelayCredentialFence {
  let fence: RelayCredentialFence = { deviceToken: client.deviceToken, hash: credential.hash, version: credential.version, pendingReqId: credential.pendingReqId };
  return fence;
}
export async function rotateRelayCredential(context: common.Context, meta: HostMeta, credential: RelayCredential, client: SpikeRpcClient): Promise<RelayCredentialUpdate> {
  if (!meta.relay) { throw new Error('Relay endpoint unavailable'); }
  let pending: RelayCredential = { token: credential.token, hash: credential.hash, version: credential.version, expiresAt: credential.expiresAt,
    graceToken: credential.graceToken, graceVersion: credential.graceVersion, graceExpiresAt: credential.graceExpiresAt,
    pendingToken: credential.pendingToken, pendingHash: credential.pendingHash, pendingReqId: credential.pendingReqId };
  if (!pending.pendingToken || !pending.pendingHash || !pending.pendingReqId) {
    pending.pendingToken = relayBase64Url(randomBytes(32)); pending.pendingHash = relayCredentialHash(pending.pendingToken);
    pending.pendingReqId = `rotate-${relayBase64Url(randomBytes(16))}`;
    await updateRelayCredential(context, meta.id, pending, undefined, credentialFence(client, credential));
    credential.pendingToken = pending.pendingToken; credential.pendingHash = pending.pendingHash; credential.pendingReqId = pending.pendingReqId;
  }
  let query: Record<string, string> = { 'installReqId': pending.pendingReqId };
  let response = await client.request('pairing.getEndpoints', JSON.stringify(query));
  if (!(response instanceof RpcSuccess)) { throw new Error('Relay rotation state unavailable'); }
  let endpoints: ESObject = JSON.parse(response.result);
  let status: ESObject = endpoints['installStatus'];
  if (!status || status['state'] !== 'committed') {
    let params: Record<string, string> = { 'reqId': pending.pendingReqId, 'newResumeTokenHash': pending.pendingHash, 'expectedCurrentHash': pending.hash };
    let provision = await client.request('pairing.provisionRelay', JSON.stringify(params));
    if (!(provision instanceof RpcSuccess)) { throw new Error('Relay rotation delivery unresolved'); }
    let installed = JSON.parse(provision.result) as Record<string, Object>;
    response = await client.request('pairing.getEndpoints', JSON.stringify(query));
    if (!(response instanceof RpcSuccess)) { throw new Error('Relay rotation status unavailable'); }
    endpoints = JSON.parse(response.result); status = endpoints['installStatus'];
    if (!status || status['state'] !== 'committed' || JSON.stringify(status['result']) !== JSON.stringify(installed)) {
      throw new Error('Relay rotation was not authoritatively committed');
    }
  }
  let installed: ESObject = status['result'];
  if (!installed || installed['v'] !== 1 || installed['reqId'] !== pending.pendingReqId
    || !Number.isSafeInteger(installed['currentVersion']) || installed['currentVersion'] <= credential.version
    || !Number.isSafeInteger(installed['resumeExpiresAt']) || installed['resumeExpiresAt'] <= Date.now()) {
    throw new Error('Invalid relay rotation install');
  }
  let next: RelayCredential = { token: pending.pendingToken, hash: pending.pendingHash,
    version: installed['currentVersion'], expiresAt: installed['resumeExpiresAt'] };
  if (Number.isSafeInteger(installed['graceExpiresAt']) && installed['graceExpiresAt'] > Date.now()) {
    next.graceToken = credential.token; next.graceVersion = credential.version; next.graceExpiresAt = installed['graceExpiresAt'];
  }
  let endpoint = readRelayEndpoint(endpoints['relay'], meta.publicKeyB64);
  await updateRelayCredential(context, meta.id, next, endpoint, credentialFence(client, pending));
  let result: RelayCredentialUpdate = { credential: next, endpoint: endpoint };
  return result;
}
