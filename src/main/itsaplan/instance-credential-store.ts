import { createHash } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'
import type { ItsaplanInstance } from '../../shared/itsaplan/itsaplan-types'
import { credentialFileExists, inCredentialFileOrder } from '../credentials/credential-file-io'
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: input is checked to be a non-null object above.
  const { id, appUrl, apiUrl } = input as Record<string, unknown>
  if (typeof id !== 'string' || typeof appUrl !== 'string' || typeof apiUrl !== 'string') {
    return null
  }
  return { id, appUrl, apiUrl }
}

async function readInstanceFileFromDisk(): Promise<ItsaplanInstanceFile> {
  const path = getInstanceFilePath()
  if (!(await credentialFileExists(path))) {
    return { instances: [] }
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: instances is re-validated entry by entry by normalizeInstance.
    const parsed = JSON.parse(await readFile(path, { encoding: 'utf-8' })) as {
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

async function readStoredInstance(): Promise<ItsaplanInstance | undefined> {
  const file = await inCredentialFileOrder(getInstanceFilePath(), () => instanceFileCache.get())
  return file.instances[0]
}

async function writeInstanceFile(file: ItsaplanInstanceFile): Promise<void> {
  return inCredentialFileOrder(getInstanceFilePath(), async () => {
    await mkdir(getOrcaDir(), { recursive: true })
    await writeFile(getInstanceFilePath(), JSON.stringify(file, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    })
    instanceFileCache.invalidate()
  })
}

/** The single connected instance, or null when none or its key file is missing. */
export async function readItsaplanInstance(): Promise<ItsaplanInstance | null> {
  const instance = await readStoredInstance()
  return instance && (await tokenFileCache.has(instance.id)) ? instance : null
}

export async function readItsaplanApiKey(instanceId: string): Promise<string | null> {
  return tokenFileCache.read(instanceId)
}

export async function saveItsaplanInstance(
  instance: ItsaplanInstance,
  apiKey: string
): Promise<void> {
  const previous = await readStoredInstance()
  await inCredentialFileOrder(`${getKeyPath(instance.id)}.mutation`, async () => {
    await mkdir(getKeyDir(), { recursive: true })
    await writeEncryptedCredential('Itsaplan', getKeyPath(instance.id), apiKey)
    // The next read hits the file, including any overlapping writer's replacement.
    tokenFileCache.forget(instance.id)
  })
  await writeInstanceFile({ instances: [instance] })
  if (previous && previous.id !== instance.id) {
    await deleteKey(previous.id)
  }
}

export async function clearItsaplanInstance(): Promise<void> {
  const previous = await readStoredInstance()
  await writeInstanceFile({ instances: [] })
  if (previous) {
    await deleteKey(previous.id)
  }
}

async function deleteKey(instanceId: string): Promise<void> {
  return inCredentialFileOrder(`${getKeyPath(instanceId)}.mutation`, async () => {
    tokenFileCache.forget(instanceId)
    try {
      await unlink(getKeyPath(instanceId))
    } catch {}
  })
}

export async function getItsaplanCredentialError(): Promise<string | undefined> {
  const instance = await readStoredInstance()
  return instance ? tokenFileCache.error(instance.id) : undefined
}

export async function getItsaplanCredentialProtection(): Promise<SecretAtRestProtection | null> {
  const instance = await readStoredInstance()
  return instance ? readCredentialFileProtection(getKeyPath(instance.id)) : null
}
