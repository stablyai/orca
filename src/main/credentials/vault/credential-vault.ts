import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { writeSecureFile } from '../../../shared/secure-storage/secure-file'
import { getSecretStore } from '../../../shared/secure-storage/secret-store'
import type { VaultEntry, VaultResult } from '../../../shared/secure-storage/credential-vault'
import {
  vaultDraftSchema,
  vaultEntrySchema,
  vaultIdSchema,
  vaultValueSchema
} from '../../../shared/rpc-contract/host-management/credential-vault-params'

const MAX_ENTRIES = 250
const FORMAT = 'orca-credential-vault-v1'
const diskSchema = z.object({
  format: z.literal(FORMAT),
  entries: z.array(z.object({ entry: vaultEntrySchema, sealed: z.string() })).max(MAX_ENTRIES)
})
const sealedValueSchema = z.tuple([z.literal(FORMAT), vaultIdSchema, vaultValueSchema])
type DiskVault = z.infer<typeof diskSchema>

export class CredentialVault {
  constructor(
    private readonly file: string,
    private readonly allowHostKey = false
  ) {}

  list(): VaultResult<VaultEntry[]> {
    return this.withVault((vault) => this.summaries(vault))
  }

  save(raw: unknown): VaultResult<VaultEntry[]> {
    const parsed = vaultDraftSchema.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, reason: 'invalid' }
    }
    const { id, value, ...fields } = parsed.data
    if (!id && value === undefined) {
      return { ok: false, reason: 'invalid' }
    }
    return this.withVault((vault) => {
      const existing = vault.entries.find((item) => item.entry.id === id)
      if (id && !existing) {
        return { ok: false, reason: 'missing' }
      }
      if (existing && existing.entry.kind !== fields.kind) {
        return { ok: false, reason: 'invalid' }
      }
      if (!existing && vault.entries.length >= MAX_ENTRIES) {
        return { ok: false, reason: 'full' }
      }
      const entry = { ...fields, id: id ?? randomUUID() }
      if (entry.kind === 'secret') {
        entry.username = ''
        entry.website = ''
      }
      const sealed = value === undefined ? existing?.sealed : this.seal([FORMAT, entry.id, value])
      if (sealed === undefined) {
        return { ok: false, reason: 'invalid' }
      }
      if (existing) {
        Object.assign(existing, { entry, sealed })
      } else {
        vault.entries.push({ entry, sealed })
      }
      return this.write(vault)
    })
  }

  remove(id: string): VaultResult<VaultEntry[]> {
    return this.withVault((vault) => {
      const index = vault.entries.findIndex(({ entry }) => entry.id === id)
      if (index === -1) {
        return { ok: false, reason: 'missing' }
      }
      vault.entries.splice(index, 1)
      return this.write(vault)
    })
  }

  readValue(id: string, kind?: VaultEntry['kind']): VaultResult<string> {
    return this.withVault((vault) => {
      const item = vault.entries.find(
        ({ entry }) => entry.id === id && (kind === undefined || entry.kind === kind)
      )
      if (!item) {
        return { ok: false, reason: 'missing' }
      }
      const [, boundId, value] = sealedValueSchema.parse(this.unseal(item.sealed))
      return boundId === id ? { ok: true, value } : { ok: false, reason: 'unavailable' }
    })
  }

  private withVault<T>(run: (vault: DiskVault) => VaultResult<T>): VaultResult<T> {
    try {
      const sealing = getSecretStore().describeSealing?.().kind
      if (sealing !== 'os-keychain' && !(this.allowHostKey && sealing === 'host-key')) {
        return { ok: false, reason: 'unprotected' }
      }
      return run(this.read())
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
  }

  private read(): DiskVault {
    let sealed: string
    try {
      sealed = readFileSync(this.file, 'utf8')
    } catch (error) {
      // Only a missing file permits starting a new vault; never replace an unreadable one.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { format: FORMAT, entries: [] }
      }
      throw error
    }
    return diskSchema.parse(this.unseal(sealed))
  }

  private write(vault: DiskVault): VaultResult<VaultEntry[]> {
    return writeSecureFile(this.file, this.seal(vault), { durable: true, ownerOnly: true })
      ? this.summaries(vault)
      : { ok: false, reason: 'unavailable' }
  }

  private summaries(vault: DiskVault): VaultResult<VaultEntry[]> {
    return { ok: true, value: vault.entries.map(({ entry }) => entry) }
  }

  private seal(value: unknown): string {
    return getSecretStore().encryptString(JSON.stringify(value)).toString('base64')
  }

  private unseal(sealed: string): unknown {
    return JSON.parse(getSecretStore().decryptString(Buffer.from(sealed, 'base64')))
  }
}
