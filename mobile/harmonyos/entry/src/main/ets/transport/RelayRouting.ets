import { http } from '@kit.NetworkKit';
import { RelayEndpoint, readRelayEndpoint } from './RelayProtocol';

export class RelayDirectorRefusedError extends Error {}

export async function resolveRelayEndpoint(endpoint: RelayEndpoint, token: string, publicKeyB64: string): Promise<RelayEndpoint> {
  let request = http.createHttp();
  let params: Record<string, Object> = { 'v': 1, 'relayHostId': endpoint.relayHostId, 'resumeToken': token };
  let header: Record<string, string> = { 'content-type': 'application/json' };
  try {
    let response = await request.request(`${endpoint.directorUrl}/v1/resolve`, {
      method: http.RequestMethod.POST, header: header, extraData: JSON.stringify(params),
      connectTimeout: 5000, readTimeout: 5000, expectDataType: http.HttpDataType.STRING
    });
    if (response.responseCode === 401) { throw new RelayDirectorRefusedError('Relay director refused the credential'); }
    if (response.responseCode !== 200 || typeof response.result !== 'string' || response.result.length > 16384) {
      throw new Error('Relay director resolve failed');
    }
    let resolved: ESObject = JSON.parse(response.result);
    if (!resolved || resolved['v'] !== 1 || !Number.isSafeInteger(resolved['leaseExpiresAt']) || resolved['leaseExpiresAt'] <= Date.now()
      || !Number.isSafeInteger(resolved['assignmentEpoch']) || resolved['assignmentEpoch'] < endpoint.assignmentEpoch) {
      throw new Error('Invalid relay director assignment');
    }
    let next: RelayEndpoint = { v: 1, directorUrl: endpoint.directorUrl, cellUrl: resolved['cellUrl'],
      assignmentEpoch: resolved['assignmentEpoch'], relayHostId: endpoint.relayHostId, e2eeFraming: 2 };
    return readRelayEndpoint(next, publicKeyB64);
  } finally { request.destroy(); }
}
