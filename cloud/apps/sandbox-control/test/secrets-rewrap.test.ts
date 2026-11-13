import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialBinding } from '../src/agent-credentials'
import { githubUserTokenBinding } from '../src/github-user-tokens'
import { createKeyring, sealedFormat, type Keyring, type SealedSecret, type SecretBinding } from '../src/secrets-crypto'
import { kekStatus, rewrapBatch, RewrapError, SEALED_TABLES } from '../src/secrets-rewrap'
import { createFakeD1 } from './d1-fake'
import { createHarness } from './harness'

// Fake keys and values only; the log check looks for every one of them.
const K0 = Buffer.alloc(32, 3).toString('base64')
const K1 = Buffer.alloc(32, 7).toString('base64')
const K2 = Buffer.alloc(32, 9).toString('base64')
const OP = 'o'.repeat(40)
const VALUES = ['org-value-aaaa-1111', 'personal-value-bbbb-2222', 'repo-value-cccc-3333', 'claude-token-dddd-4444', 'gh-token-eeee-5555']
const NEVER_LOGGED = [...VALUES, K0, K1, K2]

let logs: string[] = []
beforeEach(() => {
  logs = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
  }
})
afterEach(() => {
  // Whatever the test did, no value and no key reached a log line.
  for (const secret of NEVER_LOGGED) {
    expect(logs.join('\n')).not.toContain(secret)
  }
  vi.restoreAllMocks()
})

type Fake = ReturnType<typeof createFakeD1>
type Stored = { table: string; binding: SecretBinding; value: string; where: string }

async function insertSecret(fake: Fake, keyring: Keyring, scope: string, owner: string, name: string, value: string): Promise<Stored> {
  const binding = { scope, ownerId: owner, name }
  const sealed = await keyring.seal(binding, value)
  fake.raw
    .prepare(
      `INSERT INTO secrets (scope, owner_id, name, kek_id, wrapped_dek, ciphertext, hint, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 1, 'alice')`
    )
    .run(scope, owner, name, sealed.kekId, sealed.wrappedDek, sealed.ciphertext)
  return { table: 'secrets', binding, value, where: `scope = '${scope}' AND owner_id = '${owner}' AND name = '${name}'` }
}

async function insertCredential(fake: Fake, keyring: Keyring, userId: string, value: string): Promise<Stored> {
  const binding = credentialBinding(userId, 'claude')
  const sealed = await keyring.seal(binding, value)
  fake.raw
    .prepare(
      `INSERT INTO agent_credentials (user_id, account_id, agent, kek_id, wrapped_dek, ciphertext, created_at, updated_at)
       VALUES (?, ?, 'claude', ?, ?, ?, 1, 1)`
    )
    .run(userId, `user:${userId}`, sealed.kekId, sealed.wrappedDek, sealed.ciphertext)
  return { table: 'agent_credentials', binding, value, where: `user_id = '${userId}' AND agent = 'claude'` }
}

async function insertGitHubToken(fake: Fake, keyring: Keyring, accountId: string, userId: string, value: string): Promise<Stored> {
  const binding = githubUserTokenBinding({ account_id: accountId, user_id: userId })
  const sealed = await keyring.seal(binding, value)
  fake.raw
    .prepare(
      `INSERT INTO github_user_tokens (account_id, user_id, github_user_id, github_login, kek_id, wrapped_dek, ciphertext, updated_at)
       VALUES (?, ?, 1, 'octo', ?, ?, ?, 1)`
    )
    .run(accountId, userId, sealed.kekId, sealed.wrappedDek, sealed.ciphertext)
  return { table: 'github_user_tokens', binding, value, where: `account_id = '${accountId}' AND user_id = '${userId}'` }
}

function read(fake: Fake, stored: Stored): SealedSecret & { updated_at: number } {
  const row = fake.raw.prepare(`SELECT kek_id, wrapped_dek, ciphertext, updated_at FROM ${stored.table} WHERE ${stored.where}`).get() as {
    kek_id: string
    wrapped_dek: string
    ciphertext: string
    updated_at: number
  }
  return { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext, updated_at: row.updated_at }
}

/** One row in each sealed table plus two more secrets, all under `keyring`. */
async function seed(fake: Fake, keyring: Keyring): Promise<Stored[]> {
  return [
    await insertSecret(fake, keyring, 'org', 'org:acme', 'ORG_VAR', VALUES[0]!),
    await insertSecret(fake, keyring, 'personal', 'user:alice', 'MY_VAR', VALUES[1]!),
    await insertSecret(fake, keyring, 'repo', 'org:acme#github.com/acme/app', 'REPO_VAR', VALUES[2]!),
    await insertCredential(fake, keyring, 'alice', VALUES[3]!),
    await insertGitHubToken(fake, keyring, 'org:acme', 'alice', VALUES[4]!)
  ]
}

async function sweep(fake: Fake, keyring: Keyring, limit: number) {
  const batches = []
  let cursor: string | null = null
  do {
    const batch = await rewrapBatch(fake.db, keyring, { limit, cursor })
    batches.push(batch)
    cursor = batch.cursor
  } while (cursor)
  return batches
}

/**
 * The v1 row layout as rows written before this change have it, built with node:crypto instead of
 * the keyring: base64(iv || ciphertext || tag) on both columns, AAD ["orca-secret-v1", layer, kekId, scope, owner, name].
 */
function legacyV1Row(kekB64: string, kekId: string, binding: SecretBinding, value: string): SealedSecret {
  const encrypt = (key: Buffer, plaintext: Buffer, layer: 'dek' | 'value') => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(JSON.stringify(['orca-secret-v1', layer, kekId, binding.scope, binding.ownerId, binding.name])))
    return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64')
  }
  const dek = randomBytes(32)
  return { kekId, ciphertext: encrypt(dek, Buffer.from(value, 'utf8'), 'value'), wrappedDek: encrypt(Buffer.from(kekB64, 'base64'), dek, 'dek') }
}

describe('rows written before this change (v1)', () => {
  const binding = { scope: 'org', ownerId: 'org:acme', name: 'ORG_VAR' }

  it('open unchanged with SECRETS_SEAL_FORMAT unset, under the active or a retired KEK', async () => {
    const row = legacyV1Row(K1, 'k1', binding, VALUES[0]!)
    const keyring = await createKeyring({ id: 'k1', key: K1 })
    expect(sealedFormat(row)).toBe('v1')
    expect(await keyring.open(binding, row)).toBe(VALUES[0])
    expect(keyring.isCurrent(row)).toBe(true)
    expect(await keyring.rewrap(binding, row)).toBeNull()
    // New rows are still written in exactly that layout: the independent reader opens them.
    const fresh = await keyring.seal(binding, VALUES[1]!)
    const open = (key: Buffer, sealed: string, layer: 'dek' | 'value') => {
      const bytes = Buffer.from(sealed, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAAD(Buffer.from(JSON.stringify(['orca-secret-v1', layer, 'k1', binding.scope, binding.ownerId, binding.name])))
      decipher.setAuthTag(bytes.subarray(bytes.length - 16))
      return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()])
    }
    expect(open(open(Buffer.from(K1, 'base64'), fresh.wrappedDek, 'dek'), fresh.ciphertext, 'value').toString('utf8')).toBe(VALUES[1])

    const retired = legacyV1Row(K0, 'k0', binding, VALUES[2]!)
    expect(await (await createKeyring({ id: 'k1', key: K1 }, { k0: K0 })).open(binding, retired)).toBe(VALUES[2])
    // Also with v2 switched on: old rows stay readable before any sweep has run.
    expect(await (await createKeyring({ id: 'k1', key: K1 }, { k0: K0 }, { sealFormat: 'v2' })).open(binding, retired)).toBe(VALUES[2])
  })

  it('are left byte-for-byte alone by the store and the sweep while the format is unset', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OP, SECRETS_KEK: K1 })
    const owner = { scope: 'personal', ownerId: 'user:alice', name: 'OLD_VAR' }
    const row = legacyV1Row(K1, 'k1', owner, VALUES[0]!)
    h.raw
      .prepare(
        `INSERT INTO secrets (scope, owner_id, name, kek_id, wrapped_dek, ciphertext, hint, created_at, updated_at, updated_by)
         VALUES ('personal', 'user:alice', 'OLD_VAR', 'k1', ?, ?, NULL, 1, 1, 'alice')`
      )
      .run(row.wrappedDek, row.ciphertext)
    const listed = await h.call('GET', '/v1/secrets?scope=personal', { bearer: await h.token('alice') })
    expect(listed.body.secrets.map((s: { name: string }) => s.name)).toEqual(['OLD_VAR'])
    expect((await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).body).toMatchObject({ sealFormat: 'v1', pending: 0, unknownKekIds: [] })
    expect((await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: {} })).body).toMatchObject({ scanned: 0, done: true })
    // A dry run under a pretend rotation proves the row opens, without writing.
    Object.assign(h.env, { SECRETS_KEK: K2, SECRETS_KEK_ID: 'k2', SECRETS_KEK_RETIRED: JSON.stringify({ k1: K1 }) })
    expect((await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: { dryRun: true } })).body).toMatchObject({ scanned: 1, resealed: 1, failed: 0 })
    const after = h.raw.prepare(`SELECT kek_id, wrapped_dek, ciphertext FROM secrets WHERE name = 'OLD_VAR'`).get()
    expect(after).toEqual({ kek_id: 'k1', wrapped_dek: row.wrappedDek, ciphertext: row.ciphertext })
  })
})

describe('v2 envelope format', () => {
  const binding = { scope: 'org', ownerId: 'org:acme', name: 'ORG_VAR' }
  const flip = (sealed: string) => {
    const at = sealed.startsWith('v2.') ? 3 : 0
    const bytes = Buffer.from(sealed.slice(at), 'base64')
    bytes[bytes.length - 1]! ^= 1
    return sealed.slice(0, at) + bytes.toString('base64')
  }

  it('round-trips, refuses tampering, a swapped identity and a stripped format marker, and is readable by a v1-sealing keyring', async () => {
    const v2 = await createKeyring({ id: 'k1', key: K1 }, {}, { sealFormat: 'v2' })
    const sealed = await v2.seal(binding, VALUES[0]!)
    expect(sealedFormat(sealed)).toBe('v2')
    expect(await v2.open(binding, sealed)).toBe(VALUES[0])
    // A Worker still sealing v1 (the default) reads v2 rows: readers ship before the format is switched on.
    const v1 = await createKeyring({ id: 'k1', key: K1 })
    expect(v1.sealFormat).toBe('v1')
    expect(sealedFormat(await v1.seal(binding, VALUES[0]!))).toBe('v1')
    expect(await v1.open(binding, sealed)).toBe(VALUES[0])

    await expect(v2.open(binding, { ...sealed, ciphertext: flip(sealed.ciphertext) })).rejects.toThrow()
    await expect(v2.open(binding, { ...sealed, wrappedDek: flip(sealed.wrappedDek) })).rejects.toThrow()
    await expect(v2.open({ ...binding, ownerId: 'org:evil' }, sealed)).rejects.toThrow()
    await expect(v2.open({ ...binding, name: 'OTHER' }, sealed)).rejects.toThrow()
    // Downgrading the marker on one or both columns never opens.
    await expect(v2.open(binding, { ...sealed, ciphertext: sealed.ciphertext.slice(3) })).rejects.toThrow('mixed secret formats')
    await expect(v2.open(binding, { ...sealed, wrappedDek: sealed.wrappedDek.slice(3), ciphertext: sealed.ciphertext.slice(3) })).rejects.toThrow()
    // A DEK wrapped for one row cannot be moved under another row's ciphertext.
    const other = await v2.seal({ ...binding, name: 'OTHER' }, 'x')
    await expect(v2.open(binding, { ...sealed, wrappedDek: other.wrappedDek })).rejects.toThrow()
  })

  it('re-wraps only the data key of a v2 row: the ciphertext is untouched and the retired KEK is no longer needed', async () => {
    const old = await createKeyring({ id: 'k0', key: K0 }, {}, { sealFormat: 'v2' })
    const sealed = await old.seal(binding, VALUES[0]!)
    const rotated = await createKeyring({ id: 'k1', key: K1 }, { k0: K0 }, { sealFormat: 'v2' })
    const moved = await rotated.rewrap(binding, sealed)
    expect(moved?.mode).toBe('rewrapped')
    expect(moved!.sealed.kekId).toBe('k1')
    expect(moved!.sealed.ciphertext).toBe(sealed.ciphertext)
    expect(moved!.sealed.wrappedDek).not.toBe(sealed.wrappedDek)
    const onlyNew = await createKeyring({ id: 'k1', key: K1 })
    expect(await onlyNew.open(binding, moved!.sealed)).toBe(VALUES[0])
    await expect(old.open(binding, moved!.sealed)).rejects.toThrow('unknown KEK id')
    // Already current: nothing to do. A v2 row also stays v2 when the Worker seals v1.
    expect(await rotated.rewrap(binding, moved!.sealed)).toBeNull()
    const v1Sealer = await createKeyring({ id: 'k2', key: K2 }, { k1: K1 })
    const again = await v1Sealer.rewrap(binding, moved!.sealed)
    expect(again?.mode).toBe('rewrapped')
    expect(again!.sealed.ciphertext).toBe(sealed.ciphertext)
  })

  it('re-seals a v1 row (its value is bound to the KEK id) and refuses rows it cannot authenticate', async () => {
    const old = await createKeyring({ id: 'k0', key: K0 })
    const sealed = await old.seal(binding, VALUES[0]!)
    const rotated = await createKeyring({ id: 'k1', key: K1 }, { k0: K0 })
    const moved = await rotated.rewrap(binding, sealed)
    expect(moved?.mode).toBe('resealed')
    expect(sealedFormat(moved!.sealed)).toBe('v1')
    expect(await (await createKeyring({ id: 'k1', key: K1 })).open(binding, moved!.sealed)).toBe(VALUES[0])
    // With v2 on, the same move upgrades the row, and a v1 row under the active KEK is upgraded too.
    const upgrading = await createKeyring({ id: 'k1', key: K1 }, { k0: K0 }, { sealFormat: 'v2' })
    expect(sealedFormat((await upgrading.rewrap(binding, sealed))!.sealed)).toBe('v2')
    expect(upgrading.isCurrent(moved!.sealed)).toBe(false)
    expect(sealedFormat((await upgrading.rewrap(binding, moved!.sealed))!.sealed)).toBe('v2')

    await expect(rotated.rewrap({ ...binding, name: 'OTHER' }, sealed)).rejects.toThrow()
    await expect(rotated.rewrap(binding, { ...sealed, wrappedDek: flip(sealed.wrappedDek) })).rejects.toThrow()
    await expect((await createKeyring({ id: 'k1', key: K1 })).rewrap(binding, sealed)).rejects.toThrow('unknown KEK id')
  })
})

describe('KEK re-wrap sweep', () => {
  it('covers every table that stores a wrapped data key', () => {
    const { raw } = createFakeD1()
    const tables = raw
      .prepare(`SELECT m.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) c WHERE m.type = 'table' AND c.name = 'wrapped_dek' ORDER BY m.name`)
      .all()
      .map((row) => (row as { name: string }).name)
    expect(SEALED_TABLES.map((spec) => spec.table).sort()).toEqual(tables)
    for (const spec of SEALED_TABLES) {
      const pk = raw
        .prepare(`SELECT name FROM pragma_table_info('${spec.table}') WHERE pk > 0 ORDER BY pk`)
        .all()
        .map((row) => (row as { name: string }).name)
      expect([...spec.key]).toEqual(pk)
    }
  })

  it('moves every row to the active KEK in resumable batches, after which the retired KEK can be dropped', async () => {
    const fake = createFakeD1()
    const stored = await seed(fake, await createKeyring({ id: 'k0', key: K0 }))
    const rotated = await createKeyring({ id: 'k1', key: K1 }, { k0: K0 })

    const before = await kekStatus(fake.db, rotated)
    expect(before).toMatchObject({ activeKekId: 'k1', sealFormat: 'v1', retiredKekIds: ['k0'], pending: 5, retiredInUse: ['k0'], retiredDroppable: [], unknownKekIds: [] })
    expect(before.tables).toEqual({
      secrets: { k0: { rows: 3, v1: 3 } },
      agent_credentials: { k0: { rows: 1, v1: 1 } },
      github_user_tokens: { k0: { rows: 1, v1: 1 } }
    })

    const batches = await sweep(fake, rotated, 2)
    expect(batches.length).toBeGreaterThan(2)
    expect(batches.slice(0, -1).every((batch) => !batch.done && batch.cursor)).toBe(true)
    expect(batches.at(-1)).toMatchObject({ done: true, cursor: null, pending: 0, failed: 0 })
    expect(batches.reduce((n, batch) => n + batch.resealed, 0)).toBe(5)
    expect(batches.map((batch) => batch.pending)).toEqual([...batches.map((batch) => batch.pending)].sort((a, b) => b - a))

    // The retired key is gone from the keyring and every row still opens to its value.
    const onlyNew = await createKeyring({ id: 'k1', key: K1 })
    for (const row of stored) {
      const sealed = read(fake, row)
      expect(sealed.kekId).toBe('k1')
      expect(sealed.updated_at).toBe(1)
      expect(await onlyNew.open(row.binding, sealed)).toBe(row.value)
    }
    expect(await kekStatus(fake.db, rotated)).toMatchObject({ pending: 0, retiredInUse: [], retiredDroppable: ['k0'] })

    // Idempotent: a second sweep finds nothing and changes nothing.
    const snapshot = stored.map((row) => read(fake, row))
    expect(await rewrapBatch(fake.db, rotated)).toMatchObject({ scanned: 0, rewrapped: 0, resealed: 0, done: true, pending: 0 })
    expect(stored.map((row) => read(fake, row))).toEqual(snapshot)
    // Progress lines carry counts and key ids.
    const progress = logs.filter((line) => line.includes('"secrets_rewrap"')).map((line) => JSON.parse(line))
    expect(progress.length).toBe(batches.length + 1)
    expect(progress[0]).toMatchObject({ event: 'secrets_rewrap', activeKekId: 'k1', scanned: 2, resealed: 2, pending: 3, done: false })
  })

  it('continues an interrupted sweep without its cursor', async () => {
    const fake = createFakeD1()
    await seed(fake, await createKeyring({ id: 'k0', key: K0 }))
    const rotated = await createKeyring({ id: 'k1', key: K1 }, { k0: K0 })
    expect(await rewrapBatch(fake.db, rotated, { limit: 2 })).toMatchObject({ scanned: 2, resealed: 2, pending: 3, done: false })
    // The caller died here. Starting over picks up exactly the rows that are left.
    expect(await rewrapBatch(fake.db, rotated, { limit: 10 })).toMatchObject({ scanned: 3, resealed: 3, pending: 0, done: true })
  })

  it('with v2 on, re-wraps data keys only: stored ciphertext does not change', async () => {
    const fake = createFakeD1()
    const stored = await seed(fake, await createKeyring({ id: 'k0', key: K0 }, {}, { sealFormat: 'v2' }))
    // One legacy v1 row under the same retired key.
    const legacy = await insertSecret(fake, await createKeyring({ id: 'k0', key: K0 }), 'personal', 'user:bob', 'LEGACY', 'legacy-value')
    const ciphertexts = stored.map((row) => read(fake, row).ciphertext)
    const rotated = await createKeyring({ id: 'k1', key: K1 }, { k0: K0 }, { sealFormat: 'v2' })

    const batches = await sweep(fake, rotated, 4)
    expect(batches.reduce((n, batch) => n + batch.rewrapped, 0)).toBe(5)
    expect(batches.reduce((n, batch) => n + batch.resealed, 0)).toBe(1)
    expect(stored.map((row) => read(fake, row).ciphertext)).toEqual(ciphertexts)
    const onlyNew = await createKeyring({ id: 'k1', key: K1 })
    for (const row of [...stored, legacy]) {
      const sealed = read(fake, row)
      expect([sealed.kekId, sealedFormat(sealed)]).toEqual(['k1', 'v2'])
      expect(await onlyNew.open(row.binding, sealed)).toBe(row.value)
    }
  })

  it('upgrades v1 rows under the active KEK once v2 is on, so the next rotation never decrypts a value', async () => {
    const fake = createFakeD1()
    const stored = await seed(fake, await createKeyring({ id: 'k1', key: K1 }))
    const v1 = await createKeyring({ id: 'k1', key: K1 })
    expect(await rewrapBatch(fake.db, v1)).toMatchObject({ scanned: 0, pending: 0, done: true })
    const v2 = await createKeyring({ id: 'k1', key: K1 }, {}, { sealFormat: 'v2' })
    expect((await kekStatus(fake.db, v2)).pending).toBe(5)
    expect(await rewrapBatch(fake.db, v2)).toMatchObject({ scanned: 5, resealed: 5, pending: 0, done: true })
    expect((await kekStatus(fake.db, v2)).tables.secrets).toEqual({ k1: { rows: 3, v1: 0 } })

    const next = await createKeyring({ id: 'k2', key: K2 }, { k1: K1 }, { sealFormat: 'v2' })
    expect(await rewrapBatch(fake.db, next)).toMatchObject({ scanned: 5, rewrapped: 5, resealed: 0, pending: 0, done: true })
    const onlyNext = await createKeyring({ id: 'k2', key: K2 })
    for (const row of stored) {
      expect(await onlyNext.open(row.binding, read(fake, row))).toBe(row.value)
    }
  })

  it('leaves unreadable rows alone, reports them by table and key id, and does not let them block the rest', async () => {
    const fake = createFakeD1()
    const old = await createKeyring({ id: 'k0', key: K0 })
    // Sorted first in `secrets`, so a sweep that retried failures forever would never get past them.
    const lost = await insertSecret(fake, await createKeyring({ id: 'kx', key: K2 }), 'org', 'org:aaa', 'LOST', 'lost-value')
    const tampered = await insertSecret(fake, old, 'org', 'org:aab', 'TAMPERED', 'tampered-value')
    fake.raw.prepare(`UPDATE secrets SET owner_id = 'org:aac' WHERE name = 'TAMPERED'`).run()
    tampered.where = `name = 'TAMPERED'`
    const stored = await seed(fake, old)
    const rotated = await createKeyring({ id: 'k1', key: K1 }, { k0: K0 })
    const untouched = [read(fake, lost), read(fake, tampered)]

    const batches = await sweep(fake, rotated, 2)
    expect(batches.reduce((n, batch) => n + batch.failed, 0)).toBe(2)
    expect(batches[0]!.failures).toEqual([
      { table: 'secrets', kekId: 'kx', reason: 'unknown_kek', rows: 1 },
      { table: 'secrets', kekId: 'k0', reason: 'unreadable', rows: 1 }
    ])
    expect(batches.at(-1)).toMatchObject({ done: true, pending: 2 })
    expect([read(fake, lost), read(fake, tampered)]).toEqual(untouched)
    for (const row of stored) {
      expect(read(fake, row).kekId).toBe('k1')
    }
    // k0 is still referenced by the row that would not open, so it is not reported droppable.
    expect(await kekStatus(fake.db, rotated)).toMatchObject({ pending: 2, retiredInUse: ['k0'], retiredDroppable: [], unknownKekIds: ['kx'] })
    // No identifier of a failing row, and nothing of its contents, is logged.
    expect(logs.join('\n')).not.toContain('org:aaa')
    expect(logs.join('\n')).not.toContain(untouched[0]!.ciphertext)
  })

  it('never overwrites a secret saved between its read and its write', async () => {
    const fake = createFakeD1()
    const [target] = await seed(fake, await createKeyring({ id: 'k0', key: K0 }))
    const rotated = await createKeyring({ id: 'k1', key: K1 }, { k0: K0 })
    const fresh = await rotated.seal(target!.binding, 'saved-mid-sweep')
    const racing = {
      prepare: (sql: string) => fake.db.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => {
        // A user saves the row after the sweep read it and before the sweep writes.
        fake.raw.prepare(`UPDATE secrets SET kek_id = ?, wrapped_dek = ?, ciphertext = ? WHERE ${target!.where}`).run(fresh.kekId, fresh.wrappedDek, fresh.ciphertext)
        return fake.db.batch(statements)
      }
    } as unknown as D1Database

    expect(await rewrapBatch(racing, rotated)).toMatchObject({ scanned: 5, resealed: 4, raced: 1, pending: 0, done: true })
    expect(await rotated.open(target!.binding, read(fake, target!))).toBe('saved-mid-sweep')
  })

  it('dry run reports what would move and whether every row opens, and writes nothing', async () => {
    const fake = createFakeD1()
    const stored = await seed(fake, await createKeyring({ id: 'k0', key: K0 }))
    const rotated = await createKeyring({ id: 'k1', key: K1 }, { k0: K0 })
    const snapshot = stored.map((row) => read(fake, row))
    const batches = []
    let cursor: string | null = null
    do {
      const batch = await rewrapBatch(fake.db, rotated, { limit: 2, cursor, dryRun: true })
      batches.push(batch)
      cursor = batch.cursor
    } while (cursor)
    expect(batches.reduce((n, batch) => n + batch.resealed, 0)).toBe(5)
    expect(batches.at(-1)).toMatchObject({ dryRun: true, done: true, pending: 5, failed: 0 })
    expect(stored.map((row) => read(fake, row))).toEqual(snapshot)
  })

  it('rejects a bad limit or a cursor it did not issue', async () => {
    const fake = createFakeD1()
    const keyring = await createKeyring({ id: 'k1', key: K1 })
    await expect(rewrapBatch(fake.db, keyring, { limit: 0 })).rejects.toThrow(RewrapError)
    await expect(rewrapBatch(fake.db, keyring, { limit: 100_000 })).rejects.toThrow(RewrapError)
    for (const cursor of ['nope', btoa('[9,null]'), btoa('[0,["only-one"]]'), btoa('[0,["a","b",3]]'), btoa('{"table":0}')]) {
      await expect(rewrapBatch(fake.db, keyring, { cursor })).rejects.toThrow('invalid_cursor')
    }
  })
})

describe('operator rotation routes', () => {
  it('are operator-only and need a configured KEK', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OP, SECRETS_KEK: K1 })
    const alice = await h.token('alice', 'acme', 'sandbox', { orgRole: 'owner' })
    expect((await h.call('GET', '/v1/internal/secrets/kek', { bearer: alice })).status).toBe(404)
    expect((await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: alice, body: {} })).status).toBe(404)
    expect((await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: 'x'.repeat(40), body: {} })).status).toBe(404)

    const unconfigured = await createHarness({ OPERATOR_TOKEN: OP })
    expect(await unconfigured.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).toEqual({ status: 503, body: { error: 'secrets_unconfigured' } })
    // A broken key config answers without echoing what was wrong with it.
    const broken = await createHarness({ OPERATOR_TOKEN: OP, SECRETS_KEK: K1, SECRETS_KEK_RETIRED: `{"k0":"${K0}"` })
    const refused = await broken.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: {} })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(refused.body)).not.toContain(K0)
    const short = await createHarness({ OPERATOR_TOKEN: OP, SECRETS_KEK: K1, SECRETS_KEK_RETIRED: JSON.stringify({ k0: 'c2hvcnQ=' }) })
    expect(await short.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).toEqual({ status: 503, body: { error: 'secrets_misconfigured' } })

    expect((await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: { limit: 0 } })).status).toBe(400)
    expect((await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: { nope: true } })).status).toBe(400)
    expect(await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: { cursor: 'nope' } })).toEqual({
      status: 400,
      body: { error: 'invalid_request', reason: 'invalid_cursor' }
    })
  })

  it('rotates a live store end to end: save under k0, rotate, sweep, drop k0, and the value is still usable', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OP, SECRETS_KEK: K0, SECRETS_KEK_ID: 'k0' })
    const alice = await h.token('alice')
    for (const [name, value] of [['FIRST_VAR', VALUES[0]!], ['SECOND_VAR', VALUES[1]!], ['THIRD_VAR', VALUES[2]!]] as const) {
      expect((await h.call('PUT', `/v1/secrets/personal/${name}`, { bearer: alice, body: { value } })).status).toBe(200)
    }

    // Rotation step 1: the new key becomes active and the old one is kept as retired.
    Object.assign(h.env, { SECRETS_KEK: K1, SECRETS_KEK_ID: 'k1', SECRETS_KEK_RETIRED: JSON.stringify({ k0: K0 }) })
    const before = await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })
    expect(before.body).toMatchObject({ activeKekId: 'k1', pending: 3, retiredInUse: ['k0'], retiredDroppable: [] })
    // A save after the rotation lands under the new key on its own.
    await h.call('PUT', '/v1/secrets/personal/FIRST_VAR', { bearer: alice, body: { value: VALUES[3]! } })

    // Step 2: sweep until done.
    const responses = []
    let cursor: string | null = null
    do {
      const res = await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: { limit: 1, cursor } })
      expect(res.status).toBe(200)
      responses.push(res.body)
      cursor = res.body.cursor
    } while (cursor)
    expect(responses.reduce((n, body) => n + body.resealed, 0)).toBe(2)
    const after = await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })
    expect(after.body).toMatchObject({ pending: 0, retiredInUse: [], retiredDroppable: ['k0'], tables: { secrets: { k1: { rows: 3, v1: 3 } } } })
    // Responses carry counts and ids, never a value, a key or stored bytes.
    const stored = h.raw.prepare('SELECT name, kek_id, wrapped_dek, ciphertext FROM secrets ORDER BY name').all() as {
      name: string
      kek_id: string
      wrapped_dek: string
      ciphertext: string
    }[]
    const wire = JSON.stringify([before.body, after.body, responses])
    for (const leaked of [...NEVER_LOGGED, ...stored.flatMap((row) => [row.wrapped_dek, row.ciphertext])]) {
      expect(wire).not.toContain(leaked)
    }

    // Step 3: the retired key is dropped; the store reads with the new key alone.
    delete h.env.SECRETS_KEK_RETIRED
    expect((await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).body).toMatchObject({ retiredKekIds: [], pending: 0, unknownKekIds: [] })
    const onlyNew = await createKeyring({ id: 'k1', key: K1 })
    const opened = await Promise.all(
      stored.map((row) => onlyNew.open({ scope: 'personal', ownerId: 'user:alice', name: row.name }, { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext }))
    )
    expect(opened).toEqual([VALUES[3], VALUES[1], VALUES[2]])
  })

  it('seals v2 only when SECRETS_SEAL_FORMAT=v2', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: OP, SECRETS_KEK: K1 })
    const alice = await h.token('alice')
    const formatOf = (name: string) => {
      const row = h.raw.prepare('SELECT wrapped_dek, ciphertext FROM secrets WHERE name = ?').get(name) as { wrapped_dek: string; ciphertext: string }
      return sealedFormat({ wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext })
    }
    await h.call('PUT', '/v1/secrets/personal/BEFORE_VAR', { bearer: alice, body: { value: VALUES[0]! } })
    expect(formatOf('BEFORE_VAR')).toBe('v1')
    for (const ignored of ['V2', 'v3', '']) {
      h.env.SECRETS_SEAL_FORMAT = ignored
      await h.call('PUT', '/v1/secrets/personal/BEFORE_VAR', { bearer: alice, body: { value: VALUES[0]! } })
      expect(formatOf('BEFORE_VAR')).toBe('v1')
    }
    h.env.SECRETS_SEAL_FORMAT = 'v2'
    await h.call('PUT', '/v1/secrets/personal/AFTER_VAR', { bearer: alice, body: { value: VALUES[1]! } })
    expect(formatOf('AFTER_VAR')).toBe('v2')
    expect((await h.call('GET', '/v1/internal/secrets/kek', { bearer: OP })).body).toMatchObject({ sealFormat: 'v2', pending: 1 })
    expect((await h.call('POST', '/v1/internal/secrets/rewrap', { bearer: OP, body: {} })).body).toMatchObject({ resealed: 1, pending: 0, done: true })
    expect(formatOf('BEFORE_VAR')).toBe('v2')
  })
})
