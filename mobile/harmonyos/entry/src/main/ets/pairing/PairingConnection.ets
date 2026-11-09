import { PairingOffer } from '../transport/E2eeV2Session';
import { PairingRelay, relayConnectUrl } from '../transport/RelayProtocol';
import { SpikeRpcClient, RpcSuccess } from '../transport/SpikeRpcClient';

export const PAIRING_CODE_REFUSED = 'desktop rejected the pairing code';

export interface PairingConnectionResult {
  client: SpikeRpcClient;
  status: RpcSuccess;
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
    client.setLogSink((line: string): void => log(`${relay ? 'Relay' : 'Direct'}: ${line}`));
    return client;
  }

  private async probe(client: SpikeRpcClient, endpoint: string, offer: PairingOffer): Promise<PairingConnectionResult> {
    await client.connect(endpoint, offer.deviceToken, offer.publicKeyB64, 'v2');
    let reply = await client.request('status.get', null, 8000);
    if (reply instanceof RpcSuccess) { return { client: client, status: reply }; }
    throw new Error(reply.errorCode === 'unauthorized' ? PAIRING_CODE_REFUSED : 'Desktop status unavailable');
  }

  private async direct(offer: PairingOffer, log: (line: string) => void): Promise<PairingConnectionResult> {
    let client = this.makeClient(false, log);
    try { return await this.probe(client, offer.endpoint, offer); }
    catch (e) { this.release(client); throw e as Error; }
  }

  private async relay(offer: PairingOffer, relay: PairingRelay, log: (line: string) => void): Promise<PairingConnectionResult> {
    let origin = relay.cellUrl;
    let assignmentEpoch = relay.assignmentEpoch;
    let assignedCell = relay.cellUrl;
    for (let attempt = 0; attempt < 3; attempt++) {
      let client = this.makeClient(true, log);
      try {
        client.configureRelay({ relayHostId: relay.relayHostId, credential: relay.inviteToken, credentialKind: 'invite' });
        return await this.probe(client, relayConnectUrl(origin, relay.relayHostId), offer);
      } catch (e) {
        let move = client.getRelayMove();
        let closeCode = client.getRelayCloseCode();
        this.release(client);
        if (this.closed || this.winner || this.refused(e as Error)) { throw e as Error; }
        if (move) {
          if (move.assignmentEpoch < assignmentEpoch ||
            (move.assignmentEpoch === assignmentEpoch && move.cellUrl !== assignedCell)) { throw e as Error; }
          origin = move.cellUrl; assignedCell = move.cellUrl; assignmentEpoch = move.assignmentEpoch;
        } else if ([0, 1006, 4409, 4503].includes(closeCode) && origin !== relay.directorUrl) {
          origin = relay.directorUrl;
        } else { throw e as Error; }
        await new Promise<void>((resolve): void => { setTimeout(resolve, 1000); });
      }
    }
    throw new Error('Relay pairing unavailable');
  }

  private refused(error: Error): boolean {
    return error.message === PAIRING_CODE_REFUSED || error.message === 'E2EE authentication rejected';
  }

  connect(offer: PairingOffer, log: (line: string) => void): Promise<PairingConnectionResult> {
    let candidates = [this.direct(offer, log)];
    if (offer.relay) { candidates.push(this.relay(offer, offer.relay, log)); }
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
