// Test-only: seals (and optionally signs) a read snapshot the way the VM does, with node:crypto,
// so the phone's pure-JS (Hermes) opener and verifier are checked against an independent writer.
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject
} from 'node:crypto'
import type { SealedReadSnapshot } from '../../../src/shared/cloud-workspaces/read-snapshot'
import type { CloudControlPlane } from './cloud-control-plane-request'

/** A VM's per-workspace Ed25519 signing key. */
export function vmSigner(): { privateKey: KeyObject; publicKeyB64: string } {
  const pair = generateKeyPairSync('ed25519')
  const raw = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x ?? '', 'base64url')
  return { privateKey: pair.privateKey, publicKeyB64: raw.toString('base64') }
}

/** Signs per src/shared/cloud-workspaces/read-snapshot-signature.ts (prefix, then ciphertext bytes). */
export function signLikeVm(
  sealed: SealedReadSnapshot,
  signer: { privateKey: KeyObject; publicKeyB64: string }
): SealedReadSnapshot {
  const message = Buffer.concat([
    Buffer.from(
      `orca-cloud-read-sig-v1:${sealed.workspaceId}:${sealed.snapshotId}:${sealed.nonceB64}:`
    ),
    Buffer.from(sealed.ciphertextB64, 'base64')
  ])
  return {
    ...sealed,
    signature: {
      publicKeyB64: signer.publicKeyB64,
      signatureB64: sign(null, message, signer.privateKey).toString('base64')
    }
  }
}

// Seals exactly as the header of src/shared/cloud-workspaces/read-snapshot.ts says the VM does.
export function sealLikeVm(args: {
  readerPublicKeyB64: string
  keyId: string
  workspaceId: string
  snapshotId: string
  payload: unknown
}): SealedReadSnapshot {
  const dek = randomBytes(32)
  const nonce = randomBytes(12)
  const body = createCipheriv('aes-256-gcm', dek, nonce)
  body.setAAD(Buffer.from(`orca-cloud-read-v1:${args.workspaceId}:${args.snapshotId}`))
  const ciphertext = Buffer.concat([
    body.update(JSON.stringify(args.payload), 'utf8'),
    body.final(),
    body.getAuthTag()
  ])
  const readerPublic = Buffer.from(args.readerPublicKeyB64, 'base64')
  const eph = generateKeyPairSync('x25519')
  const ephRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x ?? '', 'base64url')
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: readerPublic.toString('base64url') },
      format: 'jwk'
    })
  })
  const kek = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephRaw, readerPublic]), 'orca-cloud-read-wrap-v1', 32)
  )
  const wrapNonce = randomBytes(12)
  const wrap = createCipheriv('aes-256-gcm', kek, wrapNonce)
  wrap.setAAD(
    Buffer.from(`orca-cloud-read-wrap-v1:${args.workspaceId}:${args.snapshotId}:${args.keyId}`)
  )
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final(), wrap.getAuthTag()])
  return {
    v: 1,
    snapshotId: args.snapshotId,
    workspaceId: args.workspaceId,
    storedAt: 2,
    nonceB64: nonce.toString('base64'),
    ciphertextB64: ciphertext.toString('base64'),
    recipient: {
      keyId: args.keyId,
      ephemeralPublicKeyB64: ephRaw.toString('base64'),
      nonceB64: wrapNonce.toString('base64'),
      wrappedKeyB64: wrapped.toString('base64')
    }
  }
}

export const PAYLOAD = {
  v: 1,
  workspaceId: 'sbx_1',
  snapshotId: 'snap_1',
  capturedAt: 1_700_000_000_000,
  reason: 'sleep',
  pr: {
    number: 42,
    title: 'Fix login',
    state: 'open',
    url: 'https://github.com/o/r/pull/42',
    checksStatus: 'success',
    checksSummary: null
  },
  git: { branch: 'fix-login', changes: [{ path: 'a.ts', added: 3, removed: 1 }], changeCount: 1 },
  sessions: [
    {
      sessionId: 's1',
      agent: 'claude',
      title: 'Login bug',
      status: 'idle',
      turnOutcome: 'completed',
      messages: [
        { itemId: 'm1', role: 'user', text: 'fix it', at: 1 },
        { itemId: 'm2', role: 'assistant', text: '**Done**', at: 2 }
      ]
    }
  ]
}

export type Call = { method: string; url: string; body: unknown }

export function fakePlane(handle: (call: Call) => { status: number; body: unknown }): {
  plane: CloudControlPlane
  calls: Call[]
} {
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    const reply = handle(call)
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }
  const plane: CloudControlPlane = {
    baseUrl: 'https://cloud.test',
    token: () => 'tok',
    fetch: fakeFetch
  }
  return { plane, calls }
}

export const registered = (id = 'rk_aaaaaaaaaaaaaaaaaaaaaaaa') => ({
  status: 200,
  body: {
    readerKey: { id, deviceKind: 'mobile', deviceLabel: 'x', createdAt: 1, lastSeenAt: 1 }
  }
})
