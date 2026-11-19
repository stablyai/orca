import { inCredentialFileOrder } from './credential-file-io'
import { readFile } from 'node:fs/promises'
import type { IntegrationCredentialService } from '../../shared/secure-storage/integration-credential-errors'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from './integration-credential-file'
import {
  createIntegrationStateFileCache,
  type IntegrationStateFileCache
} from './integration-state-file-cache'

type TokenFileState = { present: boolean; token?: string; error?: string }
const MAX_CREDENTIAL_ENTRIES = 128

export function createIntegrationTokenFileCache(args: {
  service: IntegrationCredentialService
  filePath: (id: string) => string
}) {
  const entries = new Map<string, IntegrationStateFileCache<TokenFileState>>()
  const stateFor = async (id: string): Promise<TokenFileState> => {
    let entry = entries.get(id)
    if (!entry) {
      entry = createIntegrationStateFileCache<TokenFileState>({
        filePath: () => args.filePath(id),
        readFromDisk: async () => ({ present: await credentialFileHasContent(args.filePath(id)) })
      })
    }
    entries.delete(id)
    entries.set(id, entry)
    while (entries.size > MAX_CREDENTIAL_ENTRIES) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) {
        break
      }
      entries.delete(oldest)
    }
    return entry.get()
  }
  async function readToken(id: string, force = true): Promise<string | null> {
    // Stamp before decrypting so a concurrent rotation cannot pin older bytes as current.
    const state = await stateFor(id)
    if (state.token !== undefined) {
      return state.token
    }
    if (!force || !state.present) {
      return null
    }
    try {
      const token = readStoredCredentialToken(args.service, await readFile(args.filePath(id)))
      if ((await stateFor(id)) !== state) {
        return readToken(id, force)
      }
      state.token = token ?? undefined
      state.error = undefined
      return token
    } catch (error) {
      if ((await stateFor(id)) !== state) {
        return readToken(id, force)
      }
      if (error instanceof CredentialDecryptionError) {
        state.error = error.message
        throw error
      }
      return null
    }
  }
  return {
    async has(id: string): Promise<boolean> {
      return inCredentialFileOrder(
        `${args.filePath(id)}.mutation`,
        async () => (await stateFor(id)).present
      )
    },
    read(id: string, force = true): Promise<string | null> {
      return inCredentialFileOrder(`${args.filePath(id)}.mutation`, () => readToken(id, force))
    },
    async error(id: string): Promise<string | undefined> {
      return inCredentialFileOrder(
        `${args.filePath(id)}.mutation`,
        async () => (await stateFor(id)).error
      )
    },
    forget(id: string): void {
      entries.delete(id)
    },
    clear(): void {
      entries.clear()
    }
  }
}
