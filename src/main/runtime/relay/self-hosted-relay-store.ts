import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getSecretStore } from '../../../shared/secret-store'
import { writeDurableSecureJsonFile } from '../../../shared/secure-file'
import type { SelfHostedRelaySettings } from '../../../shared/mobile-relay-provider'
import { getSelfHostedRelayConfig, type SelfHostedRelayConfig } from './self-hosted-relay-config'

const StoredRelaySchema = z.object({
  url: z.string(),
  encryptedKey: z.string().min(1),
  configurationId: z.string().min(1)
})

export type SavedSelfHostedRelay = {
  config: SelfHostedRelayConfig
  configurationId: string
}

/** Keeps the owner key out of global settings and pairing URLs. */
export class SelfHostedRelayStore {
  private readonly path: string

  constructor(
    userDataPath: string,
    private readonly packaged: boolean
  ) {
    this.path = join(userDataPath, 'mobile-self-hosted-relay.json')
  }

  read(): SavedSelfHostedRelay | null {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw new Error('Could not read the saved self-hosted Relay settings.')
    }
    try {
      const saved = StoredRelaySchema.parse(JSON.parse(raw))
      const accessKey = getSecretStore().decryptString(Buffer.from(saved.encryptedKey, 'base64'))
      return {
        config: getSelfHostedRelayConfig({ url: saved.url, accessKey }, this.packaged),
        configurationId: saved.configurationId
      }
    } catch {
      throw new Error(
        'Could not unlock the saved Relay key. Unlock the OS keyring or save it again.'
      )
    }
  }

  save(settings: SelfHostedRelaySettings): SavedSelfHostedRelay {
    const config = getSelfHostedRelayConfig(settings, this.packaged)
    const secrets = getSecretStore()
    if (!secrets.isEncryptionAvailable() || secrets.describeProtectionGap()) {
      throw new Error('Unlock the OS keyring before saving a self-hosted Relay key.')
    }
    const configurationId = randomUUID()
    try {
      writeDurableSecureJsonFile(this.path, {
        url: config.relayDirectorUrl,
        encryptedKey: secrets.encryptString(config.accessKey).toString('base64'),
        configurationId
      })
    } catch {
      throw new Error(
        'Could not save the encrypted Relay settings. Check your OS keyring and storage permissions.'
      )
    }
    return { config, configurationId }
  }

  remove(): void {
    try {
      rmSync(this.path, { force: true })
    } catch {
      throw new Error('Could not remove the saved Relay settings.')
    }
  }
}
