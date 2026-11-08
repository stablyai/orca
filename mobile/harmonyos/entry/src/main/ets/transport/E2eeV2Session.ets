import { uint32Bytes, uint64LeBytes, utf8Encode, utf8Decode, concatBytes, equalBytes, base64Encode, base64DecodeCanonical, base64UrlDecode } from './crypto/Bytes';
import { sha256, hkdfSha256 } from './crypto/Sha256';
import {
  naclBoxBefore, naclBoxAfter, naclBoxOpenAfter, naclGenerateKeyPair, naclRandomBytes, naclSecretbox, naclSecretboxOpen,
  SECRETBOX_OVERHEAD_LENGTH, SECRETBOX_KEY_LENGTH, SECRETBOX_NONCE_LENGTH, NaclBoxKeyPair
} from './NaclBinding';

/**
 * Port of Orca's mobile E2EE v2 client protocol (byte-compatible with upstream):
 *   - src/shared/remote-runtime/e2ee/mobile-e2ee-v2-contract.ts   (hello/ready validation + transcript encoding)
 *   - src/shared/remote-runtime/e2ee/mobile-e2ee-v2-framing.ts    (secretbox frame seal/open)
 *   - src/shared/remote-runtime/e2ee/paired-e2ee-v2-client-session.ts (session state machine)
 *   - src/shared/remote-runtime/e2ee/paired-e2ee-v2-key-schedule.ts   (HKDF key schedule)
 */

export const MOBILE_E2EE_V2_PROTOCOL = 'orca-mobile-e2ee';
export const MOBILE_E2EE_V2_TRANSCRIPT_DOMAIN = 'orca-mobile-e2ee/v2/transcript';

const NONCE_LENGTH = SECRETBOX_NONCE_LENGTH;
const SESSION_ID_LENGTH = 32;
const HEADER_LENGTH = SESSION_ID_LENGTH + 1 + 1 + 8;
const FRAME_VERSION = 2;

type TransportKind = 'direct' | 'relay';

interface V2CapabilitiesWire {
  framing: number[];
  payloadKinds: string[];
}

interface V2HelloContextWire {
  protocol: string;
  initiator: string;
  responder: string;
  transport: string;
  relayHostId?: string;
}

interface V2HelloWire {
  type: string;
  v: number;
  clientPublicKeyB64: string;
  clientNonceB64: string;
  capabilities: V2CapabilitiesWire;
  context: V2HelloContextWire;
}

export interface V2Context {
  protocol: string;
  initiator: string;
  responder: string;
  transport: TransportKind;
  relayHostId: string; // empty string when absent
}

export interface V2KeySchedule {
  mobileToDesktopKey: Uint8Array;
  desktopToMobileKey: Uint8Array;
  sessionId: Uint8Array;
  transcriptHash: Uint8Array;
}

type JsonRecord = Record<string, Object>;

function isRecord(value: Object | null | undefined): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysSorted(value: JsonRecord): string[] {
  let keys = Object.keys(value);
  keys.sort();
  return keys;
}

function exactRecord(value: JsonRecord, keys: string[]): boolean {
  let actual = keysSorted(value);
  let expected = keys.slice();
  expected.sort();
  if (actual.length !== expected.length) {
    return false;
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

function stringOf(value: Object | undefined | null): string | null {
  if (typeof value === 'string') {
    return value as string;
  }
  return null;
}

function decodeCanonicalBase64Bytes(value: string, length: number): Uint8Array | null {
  if (value.length !== Math.ceil(length / 3) * 4) {
    return null;
  }
  let bytes = base64DecodeCanonical(value);
  if (!bytes || bytes.length !== length) {
    return null;
  }
  return bytes;
}

function parseContext(value: Object | undefined): V2Context | null {
  if (!isRecord(value)) {
    return null;
  }
  let rec = value as JsonRecord;
  let transport = stringOf(rec['transport']);
  if (transport !== 'direct' && transport !== 'relay') {
    return null;
  }
  let relayHostId: string = '';
  if (transport === 'relay') {
    let hostIdRaw = stringOf(rec['relayHostId']);
    if (hostIdRaw === null || !/^[A-Za-z0-9_-]{16}$/.test(hostIdRaw)) {
      return null;
    }
    relayHostId = hostIdRaw;
    if (!exactRecord(rec, ['protocol', 'initiator', 'responder', 'transport', 'relayHostId'])) {
      return null;
    }
  } else if (!exactRecord(rec, ['protocol', 'initiator', 'responder', 'transport'])) {
    return null;
  }
  if (stringOf(rec['protocol']) !== MOBILE_E2EE_V2_PROTOCOL
    || stringOf(rec['initiator']) !== 'mobile'
    || stringOf(rec['responder']) !== 'desktop') {
    return null;
  }
  return {
    protocol: MOBILE_E2EE_V2_PROTOCOL,
    initiator: 'mobile',
    responder: 'desktop',
    transport: transport as TransportKind,
    relayHostId: relayHostId
  };
}

function encodeNumberList(values: number[]): Uint8Array {
  let parts: Uint8Array[] = [uint32Bytes(values.length)];
  for (let i = 0; i < values.length; i++) {
    parts.push(uint32Bytes(values[i]));
  }
  return concatBytes(parts);
}

function encodeStringList(values: string[]): Uint8Array {
  let parts: Uint8Array[] = [uint32Bytes(values.length)];
  for (let i = 0; i < values.length; i++) {
    let bytes = utf8Encode(values[i]);
    parts.push(uint32Bytes(bytes.length));
    parts.push(bytes);
  }
  return concatBytes(parts);
}

function transcriptField(name: string, value: Uint8Array): Uint8Array {
  let nameBytes = utf8Encode(name);
  return concatBytes([uint32Bytes(nameBytes.length), nameBytes, uint32Bytes(value.length), value]);
}

function transcriptStringField(name: string, value: string): Uint8Array {
  return transcriptField(name, utf8Encode(value));
}

/**
 * Binary transcript encoding — byte-identical to upstream encodeMobileE2EEV2Transcript.
 * Field order and labels are protocol-critical; do not reorder.
 */
function encodeTranscript(
  clientPublicKey: Uint8Array, clientNonce: Uint8Array,
  desktopPublicKey: Uint8Array, desktopNonce: Uint8Array,
  helloContext: V2Context, readyContext: V2Context
): Uint8Array {
  let fields: Uint8Array[] = [
    transcriptStringField('domain', MOBILE_E2EE_V2_TRANSCRIPT_DOMAIN),
    transcriptStringField('mobile-to-desktop.type', 'e2ee_hello'),
    transcriptField('mobile-to-desktop.version', uint32Bytes(2)),
    transcriptField('mobile-to-desktop.client-public-key', clientPublicKey),
    transcriptField('mobile-to-desktop.client-nonce', clientNonce),
    transcriptField('mobile-to-desktop.capabilities.framing', encodeNumberList([2])),
    transcriptField('mobile-to-desktop.capabilities.payload-kinds', encodeStringList(['text', 'binary'])),
    transcriptStringField('mobile-to-desktop.context.protocol', helloContext.protocol),
    transcriptStringField('mobile-to-desktop.context.initiator', helloContext.initiator),
    transcriptStringField('mobile-to-desktop.context.responder', helloContext.responder),
    transcriptStringField('mobile-to-desktop.context.transport', helloContext.transport),
    transcriptStringField('mobile-to-desktop.context.relay-host-id', helloContext.relayHostId),
    transcriptStringField('desktop-to-mobile.type', 'e2ee_ready'),
    transcriptField('desktop-to-mobile.version', uint32Bytes(2)),
    transcriptField('desktop-to-mobile.desktop-public-key', desktopPublicKey),
    transcriptField('desktop-to-mobile.client-nonce-echo', clientNonce),
    transcriptField('desktop-to-mobile.desktop-nonce', desktopNonce),
    transcriptField('desktop-to-mobile.selection.framing', uint32Bytes(2)),
    transcriptField('desktop-to-mobile.selection.payload-kinds', encodeStringList(['text', 'binary'])),
    transcriptStringField('desktop-to-mobile.context.protocol', readyContext.protocol),
    transcriptStringField('desktop-to-mobile.context.initiator', readyContext.initiator),
    transcriptStringField('desktop-to-mobile.context.responder', readyContext.responder),
    transcriptStringField('desktop-to-mobile.context.transport', readyContext.transport),
    transcriptStringField('desktop-to-mobile.context.relay-host-id', readyContext.relayHostId)
  ];
  return concatBytes(fields);
}

function deriveKeySchedule(
  clientSecretKey: Uint8Array, pinnedDesktopPublicKey: Uint8Array,
  clientNonce: Uint8Array, desktopNonce: Uint8Array, transcript: Uint8Array
): V2KeySchedule {
  if (clientNonce.length !== 32 || desktopNonce.length !== 32) {
    throw new Error('Invalid E2EE v2 nonce length');
  }
  let sharedSecret = naclBoxBefore(pinnedDesktopPublicKey, clientSecretKey);
  if (sharedSecret.length !== 32) {
    throw new Error('Invalid shared secret length');
  }
  let transcriptHash = sha256(transcript);
  let SALT_LABEL = utf8Encode('orca-mobile-e2ee/v2/salt\u0000');
  let INFO_LABEL = utf8Encode('orca-mobile-e2ee/v2/session\u0000');
  let salt = sha256(concatBytes([SALT_LABEL, clientNonce, desktopNonce]));
  let info = concatBytes([INFO_LABEL, transcriptHash]);
  let expanded = hkdfSha256(sharedSecret, salt, info, 96);
  return {
    mobileToDesktopKey: expanded.slice(0, 32),
    desktopToMobileKey: expanded.slice(32, 64),
    sessionId: expanded.slice(64, 96),
    transcriptHash: transcriptHash
  };
}

// ---- frame codec (mobile-e2ee-v2-framing.ts) ----

function directionByte(direction: string): number {
  return direction === 'mobile-to-desktop' ? 0 : 1;
}

function payloadKindByte(kind: string): number {
  return kind === 'text' ? 0 : 1;
}

function encodeHeader(sessionId: Uint8Array, direction: string, kind: string, counter: number): Uint8Array {
  let header = new Uint8Array(HEADER_LENGTH);
  header.set(sessionId, 0);
  header[SESSION_ID_LENGTH] = directionByte(direction);
  header[SESSION_ID_LENGTH + 1] = payloadKindByte(kind);
  header.set(uint64LeBytes(counter), SESSION_ID_LENGTH + 2);
  return header;
}

function encodeNonce(sessionId: Uint8Array, direction: string, kind: string, counter: number): Uint8Array {
  let nonce = new Uint8Array(NONCE_LENGTH);
  nonce.set(sessionId.subarray(0, 12), 0);
  nonce[12] = FRAME_VERSION;
  nonce[13] = directionByte(direction);
  nonce[14] = payloadKindByte(kind);
  nonce[15] = 0;
  nonce.set(uint64LeBytes(counter), 16);
  return nonce;
}

function sealFrame(payload: Uint8Array, key: Uint8Array, sessionId: Uint8Array,
  direction: string, kind: string, counter: number): Uint8Array {
  if (key.length !== SECRETBOX_KEY_LENGTH) {
    throw new Error(`Invalid E2EE v2 key length: ${key.length}`);
  }
  if (sessionId.length !== SESSION_ID_LENGTH) {
    throw new Error(`Invalid E2EE v2 session ID length: ${sessionId.length}`);
  }
  let header = encodeHeader(sessionId, direction, kind, counter);
  let nonce = encodeNonce(sessionId, direction, kind, counter);
  let plaintext = concatBytes([header, payload]);
  let box = naclSecretbox(plaintext, nonce, key);
  return concatBytes([nonce, box]);
}

function openFrame(frame: Uint8Array, key: Uint8Array, sessionId: Uint8Array,
  direction: string, kind: string, expectedCounter: number): Uint8Array | null {
  if (key.length !== SECRETBOX_KEY_LENGTH || sessionId.length !== SESSION_ID_LENGTH) {
    return null;
  }
  if (frame.length < NONCE_LENGTH + SECRETBOX_OVERHEAD_LENGTH + HEADER_LENGTH) {
    return null;
  }
  let nonce = encodeNonce(sessionId, direction, kind, expectedCounter);
  if (!equalBytes(frame.subarray(0, NONCE_LENGTH), nonce)) {
    return null;
  }
  let box = frame.subarray(NONCE_LENGTH);
  let plaintext = naclSecretboxOpen(box, nonce, key);
  if (!plaintext) {
    return null;
  }
  let header = encodeHeader(sessionId, direction, kind, expectedCounter);
  if (!equalBytes(plaintext.subarray(0, HEADER_LENGTH), header)) {
    return null;
  }
  return plaintext.slice(HEADER_LENGTH);
}

// ---- client session ----

export class E2eeV2ClientSession {
  private clientSecretKey: Uint8Array;
  private clientPublicKey: Uint8Array;
  private clientNonce: Uint8Array;
  private pinnedDesktopPublicKey: Uint8Array;
  private helloContext: V2Context;
  readonly helloJson: string;
  private schedule: V2KeySchedule | null = null;
  private transcriptHashB64Value: string | null = null;
  private inboundCounter = 0;
  private outboundCounter = 0;

  constructor(transport: TransportKind, relayHostId: string) {
    let keyPair: NaclBoxKeyPair = naclGenerateKeyPair();
    this.clientSecretKey = keyPair.secretKey;
    this.clientPublicKey = keyPair.publicKey;
    this.clientNonce = naclRandomBytes(32);
    if (this.clientNonce.length !== 32) {
      throw new Error(`Invalid client nonce length: ${this.clientNonce.length}`);
    }
    this.helloContext = {
      protocol: MOBILE_E2EE_V2_PROTOCOL,
      initiator: 'mobile',
      responder: 'desktop',
      transport: transport,
      relayHostId: relayHostId
    };
    let hello: V2HelloWire = {
      type: 'e2ee_hello',
      v: 2,
      clientPublicKeyB64: base64Encode(this.clientPublicKey),
      clientNonceB64: base64Encode(this.clientNonce),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
      context: {
        protocol: MOBILE_E2EE_V2_PROTOCOL,
        initiator: 'mobile',
        responder: 'desktop',
        transport: transport as string
      }
    };
    if (relayHostId.length > 0) {
      hello.context.relayHostId = relayHostId;
    }
    this.helloJson = JSON.stringify(hello);
    // pinnedDesktopPublicKey is set by setPinnedKey before acceptReady.
    this.pinnedDesktopPublicKey = new Uint8Array(32);
  }

  setPinnedKey(publicKeyB64: string): void {
    let key = base64DecodeCanonical(publicKeyB64);
    if (!key || key.length !== 32) {
      throw new Error(`Invalid desktop public key: expected 32 bytes from "${publicKeyB64.slice(0, 20)}..."`);
    }
    this.pinnedDesktopPublicKey = key;
  }

  /**
   * Validate the desktop ready per the exact-record contract, pin-check its key,
   * derive the key schedule and latch the transcript. False on any mismatch.
   */
  acceptReady(readyRaw: Object | null): boolean {
    console.info('[e2ee-v2] acceptReady: stage 0 enter');
    if (!isRecord(readyRaw)) {
      return false;
    }
    let ready = readyRaw as JsonRecord;
    if (!exactRecord(ready, ['type', 'v', 'desktopPublicKeyB64', 'clientNonceB64', 'desktopNonceB64', 'selection', 'context'])) {
      console.info('[e2ee-v2] acceptReady: reject exact-record');
      return false;
    }
    if (stringOf(ready['type']) !== 'e2ee_ready') {
      return false;
    }
    if (ready['v'] !== 2) {
      return false;
    }
    let selection = ready['selection'];
    if (!isRecord(selection)) {
      return false;
    }
    let selectionRec = selection as JsonRecord;
    if (!exactRecord(selectionRec, ['framing', 'payloadKinds']) || selectionRec['framing'] !== 2) {
      console.info('[e2ee-v2] acceptReady: reject selection');
      return false;
    }
    let kindsValue: Object = selectionRec['payloadKinds'];
    if (!Array.isArray(kindsValue)) {
      return false;
    }
    let kinds = kindsValue as Array<string>;
    if (kinds.length !== 2 || kinds[0] !== 'text' || kinds[1] !== 'binary') {
      return false;
    }
    console.info('[e2ee-v2] acceptReady: stage 1 shape ok');
    let readyContext = parseContext(ready['context']);
    if (!readyContext || readyContext.transport !== this.helloContext.transport
      || readyContext.relayHostId !== this.helloContext.relayHostId) {
      console.info('[e2ee-v2] acceptReady: reject context');
      return false;
    }
    if (stringOf(ready['clientNonceB64']) !== base64Encode(this.clientNonce)) {
      console.info('[e2ee-v2] acceptReady: reject nonce echo');
      return false;
    }
    console.info('[e2ee-v2] acceptReady: stage 2 context ok');
    let desktopPublicKey = decodeCanonicalBase64Bytes(stringOf(ready['desktopPublicKeyB64']) ?? '', 32);
    let desktopNonce = decodeCanonicalBase64Bytes(stringOf(ready['desktopNonceB64']) ?? '', 32);
    if (!desktopPublicKey || !desktopNonce) {
      console.info('[e2ee-v2] acceptReady: reject key/nonce decode');
      return false;
    }
    if (!equalBytes(desktopPublicKey, this.pinnedDesktopPublicKey)) {
      console.info('[e2ee-v2] acceptReady: reject pinned key mismatch');
      return false;
    }
    console.info('[e2ee-v2] acceptReady: stage 3 keys ok');
    let transcript: Uint8Array;
    try {
      transcript = encodeTranscript(
        this.clientPublicKey, this.clientNonce, desktopPublicKey, desktopNonce,
        this.helloContext, readyContext
      );
    } catch (e) {
      let err = e as Error;
      console.error('[e2ee-v2] encodeTranscript failed: %{public}s', err.message);
      console.error('[e2ee-v2] stack: %{public}s', err.stack ?? 'no stack');
      throw new Error(`${err.message}\n${err.stack ?? ''}`);
    }
    console.info('[e2ee-v2] acceptReady: stage 4 transcript ok');
    try {
      this.schedule = deriveKeySchedule(
        this.clientSecretKey, this.pinnedDesktopPublicKey, this.clientNonce, desktopNonce, transcript
      );
    } catch (e) {
      let err = e as Error;
      console.error('[e2ee-v2] deriveKeySchedule failed: %{public}s', err.message);
      console.error('[e2ee-v2] stack: %{public}s', err.stack ?? 'no stack');
      throw new Error(`${err.message}\n${err.stack ?? ''}`);
    }
    console.info('[e2ee-v2] acceptReady: stage 5 schedule ok');
    this.transcriptHashB64Value = base64Encode(this.schedule.transcriptHash);
    return true;
  }

  get isReady(): boolean {
    return this.transcriptHashB64Value !== null;
  }

  get transcriptHashB64(): string {
    if (!this.transcriptHashB64Value) {
      throw new Error('E2EE v2 ready has not been accepted');
    }
    return this.transcriptHashB64Value;
  }

  openText(frameB64: string): string | null {
    let frame = base64DecodeCanonical(frameB64);
    if (!frame) {
      return null;
    }
    if (!this.schedule) {
      return null;
    }
    let plaintext = openFrame(frame, this.schedule.desktopToMobileKey, this.schedule.sessionId,
      'desktop-to-mobile', 'text', this.inboundCounter);
    if (!plaintext) {
      return null;
    }
    this.inboundCounter++;
    return utf8Decode(plaintext);
  }

  openBinary(frame: Uint8Array): Uint8Array | null {
    if (!this.schedule) {
      return null;
    }
    let plaintext = openFrame(frame, this.schedule.desktopToMobileKey, this.schedule.sessionId,
      'desktop-to-mobile', 'binary', this.inboundCounter);
    if (!plaintext) {
      return null;
    }
    this.inboundCounter++;
    return plaintext;
  }

  sealText(plaintext: string): string {
    return base64Encode(this.sealBytes(utf8Encode(plaintext), 'text'));
  }

  sealBinary(plaintext: Uint8Array): Uint8Array {
    return this.sealBytes(plaintext, 'binary');
  }

  private sealBytes(plaintext: Uint8Array, kind: string): Uint8Array {
    if (!this.schedule) {
      throw new Error('E2EE v2 ready has not been accepted');
    }
    let frame = sealFrame(plaintext, this.schedule.mobileToDesktopKey, this.schedule.sessionId,
      'mobile-to-desktop', kind, this.outboundCounter);
    this.outboundCounter++;
    return frame;
  }
}

interface V2TokenAuthWire {
  type: string;
  v: number;
  transcriptHashB64: string;
  deviceToken: string;
}

/** Build the sealed v2 token auth payload (pairedE2EEV2TokenAuth upstream). */
export function buildV2TokenAuthJson(transcriptHashB64: string, deviceToken: string): string {
  let auth: V2TokenAuthWire = {
    type: 'e2ee_auth',
    v: 2,
    transcriptHashB64: transcriptHashB64,
    deviceToken: deviceToken
  };
  return JSON.stringify(auth);
}

/**
 * Parse a pairing offer from `orca://pair?code=...`, raw base64url, or raw JSON.
 * Field contract: src/shared/remote-runtime/pairing/mobile-relay-pairing-offer.ts (v: 2).
 */
export interface PairingOffer {
  endpoint: string;
  deviceToken: string;
  publicKeyB64: string;
  scope: string; // 'mobile' | 'runtime' | ''
  hasRelay: boolean;
}

export function parsePairingOffer(raw: string): PairingOffer {
  let text = raw.trim();
  if (!text.startsWith('{')) {
    let codeIndex = text.indexOf('code=');
    if (text.startsWith('orca://') && codeIndex > 0) {
      let code = text.substring(codeIndex + 5);
      let amp = code.indexOf('&');
      if (amp > 0) {
        code = code.substring(0, amp);
      }
      text = utf8Decode(base64UrlDecode(decodeURIComponent(code)));
    } else {
      text = utf8Decode(base64UrlDecode(text));
    }
  }
  let parsed: Object | null = JSON.parse(text) as Object | null;
  if (!isRecord(parsed)) {
    throw new Error('Pairing offer is not a JSON object');
  }
  let offer = parsed as JsonRecord;
  if (offer['v'] !== 2) {
    throw new Error(`Unsupported pairing offer version: ${offer['v']}`);
  }
  let endpoint = stringOf(offer['endpoint']);
  let deviceToken = stringOf(offer['deviceToken']);
  let publicKeyB64 = stringOf(offer['publicKeyB64']);
  if (endpoint === null || deviceToken === null || publicKeyB64 === null) {
    throw new Error('Pairing offer missing endpoint/deviceToken/publicKeyB64');
  }
  let scope = stringOf(offer['scope']);
  return {
    endpoint: endpoint,
    deviceToken: deviceToken,
    publicKeyB64: publicKeyB64,
    scope: scope ?? '',
    hasRelay: isRecord(offer['relay'])
  };
}


/**
 * Legacy v1 channel (upstream mobile/src/transport/e2ee.ts, byte-compatible):
 * hello `{type:'e2ee_hello', publicKeyB64}` → plaintext `{type:'e2ee_ready'}` →
 * per-message nonce||box.after bundles in padded base64. This is the framing the
 * upstream mock server (mobile/scripts/mock-server.ts) speaks.
 */
export class LegacyE2eeChannel {
  private sharedKey: Uint8Array;
  readonly helloJson: string;

  constructor(serverPublicKeyB64: string) {
    let serverKey = base64DecodeCanonical(serverPublicKeyB64);
    if (!serverKey || serverKey.length !== 32) {
      throw new Error(`Invalid legacy server public key: "${serverPublicKeyB64.slice(0, 20)}..."`);
    }
    let keyPair = naclGenerateKeyPair();
    this.sharedKey = naclBoxBefore(serverKey, keyPair.secretKey);
    this.helloJson = JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: base64Encode(keyPair.publicKey)
    });
  }

  /** Upstream acceptReadyText: JSON with type === 'e2ee_ready'. */
  acceptReady(readyText: string): boolean {
    let parsed: Object | null = JSON.parse(readyText) as Object | null;
    if (!isRecord(parsed)) {
      return false;
    }
    let ready = parsed as JsonRecord;
    return stringOf(ready['type']) === 'e2ee_ready';
  }

  sealText(plaintext: string): string {
    let nonce = naclRandomBytes(24);
    let ciphertext = naclBoxAfter(utf8Encode(plaintext), nonce, this.sharedKey);
    let bundle = concatBytes([nonce, ciphertext]);
    return base64Encode(bundle);
  }

  openText(frameB64: string): string | null {
    let bundle = base64DecodeCanonical(frameB64);
    if (!bundle || bundle.length < 24 + 16) {
      return null;
    }
    let nonce = bundle.subarray(0, 24);
    let ciphertext = bundle.subarray(24);
    let plaintext = naclBoxOpenAfter(ciphertext, nonce, this.sharedKey);
    if (!plaintext) {
      return null;
    }
    return utf8Decode(plaintext);
  }
}
