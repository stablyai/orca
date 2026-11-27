import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import type { ItsaplanInstance } from '../../shared/itsaplan/itsaplan-types'
import { readCredentialFileProtection } from '../credentials/credential-file-protection'
import { writeEncryptedCredential } from '../credentials/integration-credential-file'
import { createIntegrationStateFileCache } from '../credentials/integration-state-file-cache'
import { createIntegrationTokenFileCache } from '../credentials/integration-token-file-cache'

type ItsaplanInstanceFile = { instances: ItsaplanInstance[] }

const instanceFileCache = createIntegrationStateFileCache({
  filePath: getInstanceFilePath,
  readFromDisk: readInstanceFileFromDisk
})
const tokenFileCache = createIntegrationTokenFileCache({
  service: 'Itsaplan',
  filePath: getKeyPath
})

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getInstanceFilePath(): string {
  return join(getOrcaDir(), 'itsaplan-instances.json')
}

function getKeyDir(): string {
  return join(getOrcaDir(), 'itsaplan-keys')
}

function getKeyPath(instanceId: string): string {
  return join(getKeyDir(), `${Buffer.from(instanceId).toString('base64url')}.enc`)
}

export function itsaplanInstanceIdForApiUrl(apiUrl: string): string {
  return createHash('sha256').update(apiUrl).digest('hex').slice(0, 16)
}

function normalizeInstance(input: unknown): ItsaplanInstance | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const { id, appUrl, apiUrl } = input as Record<string, unknown>
  if (typeof id !== 'string' || typeof appUrl !== 'string' || typeof apiUrl !== 'string') {
    return null
  }
  return { id, appUrl, apiUrl }
}

function readInstanceFileFromDisk(): ItsaplanInstanceFile {
  const path = getInstanceFilePath()
  if (!existsSync(path)) {
    return { instances: [] }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as {
      instances?: unknown
    }
    const instances = Array.isArray(parsed.instances)
      ? parsed.instances
          .map(normalizeInstance)
          .filter((instance): instance is ItsaplanInstance => instance !== null)
      : []
    return { instances }
  } catch {
    return { instances: [] }
  }
}

function writeInstanceFile(file: ItsaplanInstanceFile): void {
  mkdirSync(getOrcaDir(), { recursive: true })
  writeFileSync(getInstanceFilePath(), JSON.stringify(file, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
  instanceFileCache.invalidate()
}

/** The single connected instance, or null when none or its key file is missing. */
export function readItsaplanInstance(): ItsaplanInstance | null {
  const instance = instanceFileCache.get().instances[0] ?? null
  return instance && tokenFileCache.has(instance.id) ? instance : null
}

export function readItsaplanApiKey(instanceId: string): string | null {
  return tokenFileCache.read(instanceId)
}

export async function saveItsaplanInstance(
  instance: ItsaplanInstance,
  apiKey: string
): Promise<void> {
  const previous = instanceFileCache.get().instances[0]
  mkdirSync(getKeyDir(), { recursive: true })
  writeEncryptedCredential('Itsaplan', getKeyPath(instance.id), apiKey)
  // The next read hits the file, including any overlapping writer's replacement.
  tokenFileCache.forget(instance.id)
  writeInstanceFile({ instances: [instance] })
  if (previous && previous.id !== instance.id) {
    deleteKey(previous.id)
  }
}

export async function clearItsaplanInstance(): Promise<void> {
  const previous = instanceFileCache.get().instances[0]
  writeInstanceFile({ instances: [] })
  if (previous) {
    deleteKey(previous.id)
  }
}

function deleteKey(instanceId: string): void {
  tokenFileCache.forget(instanceId)
  try {
    unlinkSync(getKeyPath(instanceId))
  } catch {}
}

export function getItsaplanCredentialError(): string | undefined {
  const instance = instanceFileCache.get().instances[0]
  return instance ? tokenFileCache.error(instance.id) : undefined
}

export function getItsaplanCredentialProtection(): SecretAtRestProtection | null {
  const instance = instanceFileCache.get().instances[0]
  return instance ? readCredentialFileProtection(getKeyPath(instance.id)) : null
}
