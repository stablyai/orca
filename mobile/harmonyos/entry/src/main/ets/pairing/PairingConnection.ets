import { PairingOffer } from '../transport/E2eeV2Session';
import { PairingRelay, RelayConnectionOptions, RelayMove, relayConnectUrl } from '../transport/RelayProtocol';
import { resolveRelayEndpoint } from '../transport/RelayRouting';
import { SpikeRpcClient, RpcSuccess } from '../transport/SpikeRpcClient';
import { randomBytes, toHex } from '../transport/crypto/Bytes';

export const PAIRING_CODE_REFUSED = 'desktop rejected the pairing code';
export const RELAY_PAIRING_CREDENTIAL_REJECTED = 'relay rejected the pairing credential';
const TICKET_EXCHANGE_CAPABILITY = 'pairing.ticket-exchange.v1';

export interface PairingConnectionResult {
  client: SpikeRpcClient;
  status: Record<string, Object> | null;
}

function readPairingResult(reply: RpcSuccess): Record<string, Object> | null {
  try {
    let result: Object | null = JSON.parse(reply.result) as Object | null;
    return result !== null && typeof result === 'object' && !Array.isArray(result)
      ? result as Record<string, Object> : null;
  } catch (e) { return null; }
}

export async function exchangePairingTicket(connection: PairingConnectionResult, ticket: string,
  log: (line: string) => void, remember: (token: string) => Promise<void>, replacement?: string): Promise<string> {
  let capabilities = connection.status?.['capabilities'];
  if (!Array.isArray(capabilities) || !(capabilities as Object[]).every((value: Object): boolean => typeof value === 'string')
    || !(capabilities as string[]).includes(TICKET_EXCHANGE_CAPABILITY)) { return ticket; }

  let newToken = replacement ?? toHex(randomBytes(24));
  await remember(newToken);
  let params: Record<string, string> = { 'deviceToken': newToken };
  let reply = await connection.client.request('pairing.exchangeTicket', JSON.stringify(params));
  if (reply instanceof RpcSuccess) {
    let deviceId = readPairingResult(reply)?.['deviceId'];
    if (typeof deviceId !== 'string' || deviceId.length === 0) { throw new Error('Pairing ticket exchange is unresolved'); }
    log('配对码已换成本机独有 token');
    return newToken;
  }
  let refusal = reply.errorCode === 'runtime_error' ? reply.errorMessage : reply.errorCode;
  if (['unknown_method', 'method_not_found', 'not_supported', 'forbidden', 'not_a_ticket', 'delegated_device',
    'ticket_already_exchanged', 'ticket_window_closed', 'ticket_exchange_pending', 'device_token_in_use', 'device_not_found']
    .includes(refusal)) {
    log('桌面未接受换票，继续使用扫码凭证');
    return ticket;
  }
  throw new Error('Pairing ticket exchange is unresolved');
}

export class PairingConnection {
  private clients: Set<SpikeRpcClient> = new Set();
  private closed: boolean = false;
  private winner: SpikeRpcClient | null = null;

  close(): void {
    this.closed = true;
    this.clients.forEach((client: SpikeRpcClient): void => client.close());
    this.clients.clear();
  }

  private release(client: SpikeRpcClient): void {
    if (this.clients.delete(client)) { client.close(); }
  }

  private makeClient(relay: boolean, log: (line: string) => void): SpikeRpcClient {
    if (this.closed || this.winner) { throw new Error('Pairing cancelled'); }
    let client = new SpikeRpcClient(relay ? 12000 : 8000);
    this.clients.add(client);
    client.setLogSink((line: string): void => {
      if (!this.closed && this.clients.has(client)) { log(`${relay ? 'Relay' : 'Direct'}: ${line}`); }
    });
    return client;
  }

  private async probe(client: SpikeRpcClient, endpoint: string, offer: PairingOffer): Promise<PairingConnectionResult> {
    await client.connect(endpoint, offer.deviceToken, offer.publicKeyB64, 'v2');
    let reply = await client.request('status.get', null, 8000);
    // A successful reply proves the authenticated path even when its status fields are unreadable.
    if (reply instanceof RpcSuccess) { return { client: client, status: readPairingResult(reply) }; }
    let refused = reply.errorCode === 'unauthorized' || client.authenticationRejected();
    throw new Error(refused ? PAIRING_CODE_REFUSED : 'Desktop status unavailable');
  }

  private async direct(offer: PairingOffer, log: (line: string) => void): Promise<PairingConnectionResult> {
    let client = this.makeClient(false, log);
    try { return await this.probe(client, offer.endpoint, offer); }
    catch (e) { this.release(client); throw e as Error; }
  }

  private async dialRelay<T>(offer: PairingOffer, relay: PairingRelay, options: RelayConnectionOptions,
    log: (line: string) => void, connect: (client: SpikeRpcClient, endpoint: string) => Promise<T>,
    onMove?: (move: RelayMove) => Promise<void>): Promise<T> {
    let origin = relay.cellUrl;
    let assignmentEpoch = relay.assignmentEpoch;
    let assignedCell = relay.cellUrl;
    for (let attempt = 0; attempt < 3; attempt++) {
      let client = this.makeClient(true, log);
      try {
        client.configureRelay(options);
        return await connect(client, relayConnectUrl(origin, relay.relayHostId));
      } catch (e) {
        let move = client.getRelayMove();
        let closeCode = client.getRelayCloseCode();
        this.release(client);
        if (this.closed || this.winner || this.refused(e as Error)) { throw e as Error; }
        if (client.relayCredentialRejected()) { throw new Error(RELAY_PAIRING_CREDENTIAL_REJECTED); }
        if (!move && options.pairingRecovery && [0, 1006, 4409, 4503].includes(closeCode) && attempt === 0) {
          let resolved = await resolveRelayEndpoint(relay, options.credential, offer.publicKeyB64);
          move = { cellUrl: resolved.cellUrl, assignmentEpoch: resolved.assignmentEpoch };
        }
        if (move) {
          if (move.assignmentEpoch < assignmentEpoch ||
            (move.assignmentEpoch === assignmentEpoch && move.cellUrl !== assignedCell)) { throw e as Error; }
          if (move.assignmentEpoch > assignmentEpoch && onMove) { await onMove(move); }
          origin = move.cellUrl; assignedCell = move.cellUrl; assignmentEpoch = move.assignmentEpoch;
        } else if (options.credentialKind === 'invite' && [0, 1006, 4409, 4503].includes(closeCode) && origin !== relay.directorUrl) {
          origin = relay.directorUrl;
        } else { throw e as Error; }
        await new Promise<void>((resolve): void => { setTimeout(resolve, 1000); });
      }
    }
    throw new Error('Relay pairing unavailable');
  }

  connectRecoveryRelay(offer: PairingOffer, relay: PairingRelay, kind: string, credential: string,
    onMove: (move: RelayMove) => Promise<void>): Promise<SpikeRpcClient> {
    return this.dialRelay(offer, relay, { relayHostId: relay.relayHostId, credential: credential,
      credentialKind: kind, pairingRecovery: kind === 'resume' }, (): void => {},
      async (client: SpikeRpcClient, endpoint: string): Promise<SpikeRpcClient> => {
        await client.connect(endpoint, offer.deviceToken, offer.publicKeyB64, 'v2');
        return client;
      }, onMove);
  }

  private refused(error: Error): boolean {
    return error.message === PAIRING_CODE_REFUSED || error.message === 'E2EE authentication rejected';
  }

  connect(offer: PairingOffer, log: (line: string) => void, onMove?: (move: RelayMove) => Promise<void>): Promise<PairingConnectionResult> {
    let candidates = [this.direct(offer, log)];
    let relay = offer.relay;
    if (relay) {
      candidates.push(this.dialRelay(offer, relay, { relayHostId: relay.relayHostId, credential: relay.inviteToken,
        credentialKind: 'invite' }, log, (client: SpikeRpcClient, endpoint: string): Promise<PairingConnectionResult> =>
          this.probe(client, endpoint, offer), onMove));
    }
    return new Promise<PairingConnectionResult>((resolve, reject): void => {
      let failures = 0;
      let refused = false;
      let chosen: PairingConnectionResult | null = null;
      let choosing = false;
      candidates.forEach((candidate: Promise<PairingConnectionResult>): void => {
        candidate.then((result: PairingConnectionResult): void => {
          if (this.closed) { reject(new Error('Pairing cancelled')); return; }
          if (this.winner) { this.release(result.client); return; }
          if (!chosen || !result.client.isRelay()) { chosen = result; }
          if (choosing) { return; }
          choosing = true;
          // Let a same-turn direct success win before closing either candidate.
          Promise.resolve().then((): void => {
            if (this.closed || !chosen) { reject(new Error('Pairing cancelled')); return; }
            this.winner = chosen.client;
            Array.from(this.clients).forEach((client: SpikeRpcClient): void => {
              if (client !== this.winner) { this.release(client); }
            });
            resolve(chosen);
          });
        }, (error: Error): void => {
          refused = refused || this.refused(error);
          failures++;
          if (failures === candidates.length) {
            reject(new Error(refused ? PAIRING_CODE_REFUSED : 'Desktop pairing paths unavailable'));
          }
        });
      });
    });
  }
}
