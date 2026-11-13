// Envelope encryption for the secret store. Each value gets a fresh AES-256-GCM data key (DEK);
// the DEK is wrapped by the key-encryption key (KEK), which exists only as a Worker secret. Both
// layers authenticate the row's (scope, owner, name) as AAD, so a ciphertext copied onto another
// row (another org, another name) fails to open instead of decrypting under the wrong identity.
//
// Two row formats:
//   v1 (no prefix): the KEK id is in the AAD of BOTH layers, so moving a row to another KEK means
//      decrypting and re-encrypting the value.
//   v2 (`v2.` prefix on wrapped_dek and ciphertext): the KEK id is in the DEK layer's AAD only, so a
//      KEK rotation re-wraps the 32-byte DEK and never touches (or decrypts) the value.
// Every Worker version that can read the database must understand v2 before SECRETS_SEAL_FORMAT=v2
// is set: an older version skips v2 rows as unreadable.

export type SecretBinding = { scope: string; ownerId: string; name: string }
export type SealedSecret = { kekId: string; wrappedDek: string; ciphertext: string }
export type SealFormat = 'v1' | 'v2'
export type Rewrapped = {
  sealed: SealedSecret
  /** `rewrapped`: only the DEK was re-wrapped (v2 rows). `resealed`: the value was decrypted and sealed again (v1 rows). */
  mode: 'rewrapped' | 'resealed'
}

export type Keyring = {
  activeId: string
  /** The format new rows are sealed in. */
  sealFormat: SealFormat
  /** Ids of the retired KEKs this keyring can still open. */
  retiredIds: string[]
  seal(binding: SecretBinding, value: string): Promise<SealedSecret>
  /** Throws on a tampered row, a swapped binding or an unknown key id. */
  open(binding: SecretBinding, sealed: SealedSecret): Promise<string>
  /** True when the row is under the active KEK and needs no format upgrade. */
  isCurrent(sealed: SealedSecret): boolean
  /**
   * Moves a row to the active KEK (and to v2 when that is the seal format); null when it is already
   * current. The result is opened again before it is returned, so a caller never stores a row this
   * keyring cannot read. Throws like `open` on a tampered row or an unknown key id.
   */
  rewrap(binding: SecretBinding, sealed: SealedSecret): Promise<Rewrapped | null>
}

const IV_BYTES = 12
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/
const V2_PREFIX = 'v2.'

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

/** Throws when the two columns disagree about the format (a spliced row). */
export function sealedFormat(sealed: Pick<SealedSecret, 'wrappedDek' | 'ciphertext'>): SealFormat {
  const dek = sealed.wrappedDek.startsWith(V2_PREFIX)
  if (dek !== sealed.ciphertext.startsWith(V2_PREFIX)) {
    throw new Error('mixed secret formats')
  }
  return dek ? 'v2' : 'v1'
}

function aad(format: SealFormat, binding: SecretBinding, layer: 'dek' | 'value', kekId: string): Uint8Array<ArrayBuffer> {
  // JSON keeps field boundaries unambiguous (a name can't bleed into the owner id).
  const identity = [binding.scope, binding.ownerId, binding.name]
  if (format === 'v1') {
    return utf8(JSON.stringify(['orca-secret-v1', layer, kekId, ...identity]))
  }
  // v2: the value is bound to its row and its DEK, not to whichever KEK currently wraps that DEK.
  return utf8(JSON.stringify(layer === 'dek' ? ['orca-secret-v2', 'dek', kekId, ...identity] : ['orca-secret-v2', 'value', ...identity]))
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length && i < b.length; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
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
 * their KEKs so rows written before a rotation still open until the re-wrap sweep
 * (src/secrets-rewrap.ts) has moved them to the active KEK.
 */
export async function createKeyring(
  active: { id: string; key: string },
  retired: Record<string, string> = {},
  options: { sealFormat?: SealFormat } = {}
): Promise<Keyring> {
  const sealFormat = options.sealFormat ?? 'v1'
  const keys = new Map<string, CryptoKey>()
  // The active entry goes last so it wins if `retired` repeats its id.
  for (const [id, b64] of [...Object.entries(retired), [active.id, active.key] as const]) {
    if (!KEY_ID.test(id)) {
      throw new Error('invalid KEK id')
    }
    if (typeof b64 !== 'string') {
      throw new Error('KEK must be base64')
    }
    const raw = fromBase64(b64)
    if (raw.length !== 32) {
      throw new Error('KEK must be 32 bytes')
    }
    keys.set(id, await importAes(raw))
    raw.fill(0)
  }
  const kek = (id: string) => {
    const key = keys.get(id)
    if (!key) {
      throw new Error('unknown KEK id')
    }
    return key
  }
  const prefix = (format: SealFormat) => (format === 'v2' ? V2_PREFIX : '')
  const body = (format: SealFormat, sealed: string) => sealed.slice(prefix(format).length)
  const unwrapDek = (binding: SecretBinding, sealed: SealedSecret, format: SealFormat) =>
    decrypt(kek(sealed.kekId), body(format, sealed.wrappedDek), aad(format, binding, 'dek', sealed.kekId))
  const wrapDek = async (binding: SecretBinding, dekRaw: Uint8Array<ArrayBuffer>, format: SealFormat) =>
    prefix(format) + (await encrypt(kek(active.id), dekRaw, aad(format, binding, 'dek', active.id)))

  async function seal(binding: SecretBinding, value: string): Promise<SealedSecret> {
    const dekRaw = crypto.getRandomValues(new Uint8Array(32))
    try {
      const dek = await importAes(dekRaw)
      const ciphertext = prefix(sealFormat) + (await encrypt(dek, utf8(value), aad(sealFormat, binding, 'value', active.id)))
      return { kekId: active.id, wrappedDek: await wrapDek(binding, dekRaw, sealFormat), ciphertext }
    } finally {
      dekRaw.fill(0)
    }
  }

  async function open(binding: SecretBinding, sealed: SealedSecret): Promise<string> {
    const format = sealedFormat(sealed)
    const dekRaw = await unwrapDek(binding, sealed, format)
    try {
      const dek = await importAes(dekRaw)
      return new TextDecoder().decode(await decrypt(dek, body(format, sealed.ciphertext), aad(format, binding, 'value', sealed.kekId)))
    } finally {
      dekRaw.fill(0)
    }
  }

  const isCurrent = (sealed: SealedSecret) => sealed.kekId === active.id && (sealFormat === 'v1' || sealedFormat(sealed) === 'v2')

  return {
    activeId: active.id,
    sealFormat,
    retiredIds: Object.keys(retired).filter((id) => id !== active.id),
    seal,
    open,
    isCurrent,
    async rewrap(binding, sealed) {
      if (isCurrent(sealed)) {
        return null
      }
      if (sealedFormat(sealed) === 'v1') {
        // A v1 value is authenticated against its KEK id, so it has to be sealed again. The plaintext
        // stays inside this function, as it does when a session start opens the row.
        const value = await open(binding, sealed)
        const next = await seal(binding, value)
        if ((await open(binding, next)) !== value) {
          throw new Error('reseal verification failed')
        }
        return { sealed: next, mode: 'resealed' }
      }
      const dekRaw = await unwrapDek(binding, sealed, 'v2')
      try {
        const next: SealedSecret = { kekId: active.id, wrappedDek: await wrapDek(binding, dekRaw, 'v2'), ciphertext: sealed.ciphertext }
        const check = await unwrapDek(binding, next, 'v2')
        const same = sameBytes(check, dekRaw)
        check.fill(0)
        if (!same) {
          throw new Error('rewrap verification failed')
        }
        return { sealed: next, mode: 'rewrapped' }
      } finally {
        dekRaw.fill(0)
      }
    }
  }
}
