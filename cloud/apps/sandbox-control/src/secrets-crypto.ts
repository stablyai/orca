// Envelope encryption for the secret store. Each value gets a fresh AES-256-GCM data key (DEK);
// the DEK is wrapped by the key-encryption key (KEK), which exists only as a Worker secret. Both
// layers authenticate the row's (scope, owner, name) as AAD, so a ciphertext copied onto another
// row (another org, another name) fails to open instead of decrypting under the wrong identity.

export type SecretBinding = { scope: string; ownerId: string; name: string }
export type SealedSecret = { kekId: string; wrappedDek: string; ciphertext: string }

export type Keyring = {
  activeId: string
  seal(binding: SecretBinding, value: string): Promise<SealedSecret>
  /** Throws on a tampered row, a swapped binding or an unknown key id. */
  open(binding: SecretBinding, sealed: SealedSecret): Promise<string>
}

const IV_BYTES = 12
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(value))
}

function aad(binding: SecretBinding, layer: 'dek' | 'value', kekId: string): Uint8Array<ArrayBuffer> {
  // JSON keeps field boundaries unambiguous (a name can't bleed into the owner id).
  return utf8(JSON.stringify(['orca-secret-v1', layer, kekId, binding.scope, binding.ownerId, binding.name]))
}

async function encrypt(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, additionalData: Uint8Array<ArrayBuffer>) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext))
  const out = new Uint8Array(IV_BYTES + ct.length)
  out.set(iv)
  out.set(ct, IV_BYTES)
  return toBase64(out)
}

async function decrypt(key: CryptoKey, sealed: string, additionalData: Uint8Array<ArrayBuffer>) {
  const bytes = fromBase64(sealed)
  const iv = bytes.slice(0, IV_BYTES)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key, bytes.slice(IV_BYTES)))
}

function importAes(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * `active` is the base64 32-byte KEK new rows are sealed with; `retired` maps older key ids to
 * their KEKs so rows written before a rotation still open (re-sealed on their next write).
 */
export async function createKeyring(active: { id: string; key: string }, retired: Record<string, string> = {}): Promise<Keyring> {
  const keys = new Map<string, CryptoKey>()
  for (const [id, b64] of [[active.id, active.key] as const, ...Object.entries(retired)]) {
    if (!KEY_ID.test(id)) {
      throw new Error('invalid KEK id')
    }
    const raw = fromBase64(b64)
    if (raw.length !== 32) {
      throw new Error('KEK must be 32 bytes')
    }
    keys.set(id, await importAes(raw))
  }
  const kek = (id: string) => {
    const key = keys.get(id)
    if (!key) {
      throw new Error('unknown KEK id')
    }
    return key
  }
  return {
    activeId: active.id,
    async seal(binding, value) {
      const dekRaw = crypto.getRandomValues(new Uint8Array(32))
      const dek = await importAes(dekRaw)
      const ciphertext = await encrypt(dek, utf8(value), aad(binding, 'value', active.id))
      const wrappedDek = await encrypt(kek(active.id), dekRaw, aad(binding, 'dek', active.id))
      dekRaw.fill(0)
      return { kekId: active.id, wrappedDek, ciphertext }
    },
    async open(binding, sealed) {
      const dekRaw = await decrypt(kek(sealed.kekId), sealed.wrappedDek, aad(binding, 'dek', sealed.kekId))
      const dek = await importAes(dekRaw)
      dekRaw.fill(0)
      return new TextDecoder().decode(await decrypt(dek, sealed.ciphertext, aad(binding, 'value', sealed.kekId)))
    }
  }
}
