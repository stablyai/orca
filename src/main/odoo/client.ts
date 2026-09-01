import { CredentialDecryptionError } from '../integration-credential-file'
import {
  deleteKey,
  getInstanceFile,
  getInstanceId,
  getStatus,
  normalizeOdooServerUrl,
  OdooServerUrlError,
  readKey,
  saveKey,
  writeInstanceFile
} from './instance-credentials'
import { acquire, authenticate, executeKw, release, type OdooClientForInstance } from './json-rpc'
import type {
  OdooConnectArgs,
  OdooConnectionStatus,
  OdooInstance,
  OdooInstanceSelection,
  OdooViewer
} from '../../shared/odoo-types'
export { getStatus, normalizeOdooServerUrl } from './instance-credentials'
export { isAuthError, OdooApiError, executeKw, acquire, release } from './json-rpc'
export type { OdooClientForInstance } from './json-rpc'

export function getClients(selection?: OdooInstanceSelection | null): OdooClientForInstance[] {
  const file = getInstanceFile()
  const selected = selection ?? file.selectedInstanceId ?? file.activeInstanceId
  const isAllSelection = selected === 'all'
  const instances = isAllSelection
    ? file.instances
    : file.instances.filter((instance) => instance.id === (selected ?? file.activeInstanceId))

  return instances.flatMap((instance) => {
    let apiKey: string | null
    try {
      apiKey = readKey(instance.id)
    } catch (error) {
      // Why: under an 'all' selection one un-decryptable instance must not
      // collapse reads for the healthy ones. readKey already recorded the
      // per-instance credentialError for getStatus to surface, so skip it like
      // a missing key. A specific selection still rethrows so the renderer can
      // surface the decrypt banner promptly.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return apiKey ? [{ instance, apiKey }] : []
  })
}

async function readViewer(
  client: OdooClientForInstance,
  fallbackLogin: string
): Promise<OdooViewer> {
  const rows = await executeKw<Record<string, unknown>[]>(
    client,
    'res.users',
    'read',
    [[client.instance.uid]],
    { fields: ['name', 'login'] }
  )
  const row = rows[0]
  return {
    uid: client.instance.uid,
    displayName: typeof row?.name === 'string' ? row.name : fallbackLogin,
    login: typeof row?.login === 'string' ? row.login : fallbackLogin
  }
}

export async function connect(
  args: OdooConnectArgs
): Promise<{ ok: true; viewer: OdooViewer } | { ok: false; error: string }> {
  let serverUrl: string
  try {
    serverUrl = normalizeOdooServerUrl(args.serverUrl)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof OdooServerUrlError ? error.message : 'Enter a valid Odoo server URL.'
    }
  }

  const database = args.database.trim()
  const login = args.login.trim()
  const apiKey = args.apiKey.trim()
  if (!database) {
    return { ok: false, error: 'Database is required.' }
  }
  if (!login || !apiKey) {
    return { ok: false, error: 'Login and API key are required.' }
  }

  await acquire()
  try {
    const uid = await authenticate(serverUrl, database, login, apiKey)
    const id = getInstanceId(serverUrl, database, login)
    const instance: OdooInstance = {
      id,
      serverUrl,
      database,
      login,
      uid,
      displayName: login
    }
    const viewer = await readViewer({ instance, apiKey }, login)

    saveKey(id, apiKey)
    const file = getInstanceFile()
    writeInstanceFile({
      version: 1,
      activeInstanceId: id,
      selectedInstanceId: id,
      instances: [
        { ...instance, displayName: viewer.displayName },
        ...file.instances.filter((entry) => entry.id !== id)
      ]
    })
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function disconnect(instanceId?: string): void {
  const file = getInstanceFile()
  const ids = instanceId ? [instanceId] : file.instances.map((instance) => instance.id)
  for (const id of ids) {
    deleteKey(id)
  }
  writeInstanceFile({
    version: 1,
    activeInstanceId: file.activeInstanceId,
    selectedInstanceId: file.selectedInstanceId,
    instances: file.instances.filter((instance) => !ids.includes(instance.id))
  })
}

export function selectInstance(instanceId: OdooInstanceSelection): OdooConnectionStatus {
  const file = getInstanceFile()
  if (instanceId !== 'all' && !file.instances.some((instance) => instance.id === instanceId)) {
    return getStatus()
  }
  writeInstanceFile({
    ...file,
    activeInstanceId: instanceId === 'all' ? file.activeInstanceId : instanceId,
    selectedInstanceId: instanceId
  })
  return getStatus()
}

export async function testConnection(
  instanceId?: string
): Promise<{ ok: true; viewer: OdooViewer } | { ok: false; error: string }> {
  let client: OdooClientForInstance | undefined
  try {
    client = getClients(instanceId)[0]
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!client) {
    return { ok: false, error: 'Not connected to Odoo.' }
  }
  await acquire()
  try {
    return { ok: true, viewer: await readViewer(client, client.instance.login) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function clearKey(instanceId: string): void {
  deleteKey(instanceId)
  const file = getInstanceFile()
  writeInstanceFile({
    ...file,
    instances: file.instances.filter((instance) => instance.id !== instanceId)
  })
}
