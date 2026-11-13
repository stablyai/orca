import { url } from '@kit.ArkTS';
import { base64Encode, base64DecodeCanonical, utf8Encode } from './crypto/Bytes';
import { sha256 } from './crypto/Sha256';

export interface RelayEndpoint {
  v: number;
  directorUrl: string;
  cellUrl: string;
  assignmentEpoch: number;
  relayHostId: string;
  e2eeFraming: number;
}
export interface PairingRelay extends RelayEndpoint {
  inviteToken: string;
  inviteExpiresAt: number;
}
export interface RelayCredential {
  token: string;
  hash: string;
  version: number;
  expiresAt: number;
  graceToken?: string;
  graceVersion?: number;
  graceExpiresAt?: number;
  pendingToken?: string;
  pendingHash?: string;
  pendingReqId?: string;
}
export interface RelayConnectionOptions {
  relayHostId: string;
  credential: string;
  credentialKind: string;
  credentialVersion?: number;
  // Recovery verifies the pending install and confirms resume in the same authenticated RPC.
  pairingRecovery?: boolean;
}
export interface RelayMove { cellUrl: string; assignmentEpoch: number; }

export function relayBase64Url(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function relayCredentialHash(token: string): string { return relayBase64Url(sha256(utf8Encode(token))); }
export function isRelayOrigin(value: string): boolean {
  if (typeof value !== 'string' || value.length > 1024) { return false; }
  try { let parsed = new url.URL(value); return parsed.protocol === 'https:' && parsed.origin === value; }
  catch (e) { return false; }
}
export function isDirectEndpoint(value: string): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || /[\x00-\x20]/.test(value)) { return false; }
  try {
    let parsed = new url.URL(value);
    return ['ws:', 'wss:'].includes(parsed.protocol) && parsed.hostname.length > 0
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch (e) { return false; }
}
export function relayConnectUrl(origin: string, hostId: string): string {
  if (!isRelayOrigin(origin) || !/^[A-Za-z0-9_-]{16}$/.test(hostId)) { throw new Error('Invalid relay endpoint'); }
  return `wss://${origin.substring(8)}/v1/connect/${hostId}`;
}
export function readRelayEndpoint(value: ESObject, publicKeyB64: string): RelayEndpoint {
  let key = base64DecodeCanonical(publicKeyB64);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value['v'] !== 1 || value['e2eeFraming'] !== 2
    || !isRelayOrigin(value['directorUrl']) || !isRelayOrigin(value['cellUrl'])
    || !Number.isSafeInteger(value['assignmentEpoch']) || value['assignmentEpoch'] < 0
    || !key || key.length !== 32 || value['relayHostId'] !== relayBase64Url(sha256(key)).substring(0, 16)) {
    throw new Error('Invalid relay identity or endpoint');
  }
  let endpoint: RelayEndpoint = { v: 1, directorUrl: value['directorUrl'], cellUrl: value['cellUrl'],
    assignmentEpoch: value['assignmentEpoch'], relayHostId: value['relayHostId'], e2eeFraming: 2 };
  return endpoint;
}
export function readPairingRelay(value: ESObject, publicKeyB64: string): PairingRelay {
  let endpoint = readRelayEndpoint(value, publicKeyB64);
  if (typeof value['inviteToken'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value['inviteToken'])
    || !Number.isSafeInteger(value['inviteExpiresAt']) || value['inviteExpiresAt'] <= Date.now()
    || value['inviteExpiresAt'] > Date.now() + 630000) { throw new Error('Invalid or expired relay invite'); }
  let relay: PairingRelay = { v: 1, directorUrl: endpoint.directorUrl, cellUrl: endpoint.cellUrl,
    assignmentEpoch: endpoint.assignmentEpoch, relayHostId: endpoint.relayHostId, e2eeFraming: 2,
    inviteToken: value['inviteToken'], inviteExpiresAt: value['inviteExpiresAt'] };
  return relay;
}
export function readRelayCredential(value: ESObject): RelayCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^[A-Za-z0-9_-]{43}$/.test(value['token']) || value['hash'] !== relayCredentialHash(value['token'])
    || !Number.isSafeInteger(value['version']) || value['version'] < 1
    || !Number.isSafeInteger(value['expiresAt']) || value['expiresAt'] < 0) { throw new Error('Invalid relay credential'); }
  if (value['graceToken'] !== undefined || value['graceVersion'] !== undefined || value['graceExpiresAt'] !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value['graceToken']) || !Number.isSafeInteger(value['graceVersion'])
      || value['graceVersion'] < 1 || value['graceVersion'] >= value['version'] || !Number.isSafeInteger(value['graceExpiresAt'])) {
      throw new Error('Invalid relay grace credential');
    }
  }
  if (value['pendingToken'] !== undefined || value['pendingHash'] !== undefined || value['pendingReqId'] !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value['pendingToken']) || value['pendingHash'] !== relayCredentialHash(value['pendingToken'])
      || typeof value['pendingReqId'] !== 'string' || value['pendingReqId'].length < 1 || value['pendingReqId'].length > 128) {
      throw new Error('Invalid pending relay credential');
    }
  }
  return value as RelayCredential;
}
