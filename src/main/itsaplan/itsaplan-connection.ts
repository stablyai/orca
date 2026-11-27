import type {
  ItsaplanConnectionStatus,
  ItsaplanResult,
  ItsaplanViewer
} from '../../shared/itsaplan/itsaplan-types'
import { ItsaplanApiError, verifyItsaplanKey } from './client'
import {
  clearItsaplanInstance,
  getItsaplanCredentialError,
  getItsaplanCredentialProtection,
  itsaplanInstanceIdForApiUrl,
  readItsaplanApiKey,
  readItsaplanInstance,
  saveItsaplanInstance
} from './instance-credential-store'
import { detectItsaplanApiUrl, normalizeItsaplanAppUrl } from './instance-url'
import { clearItsaplanProjectCaches } from './itsaplan-project-queries'

let cachedViewer: { instanceId: string; viewer: ItsaplanViewer } | null = null

export function itsaplanDetectApiUrl(args: { appUrl: string }) {
  return detectItsaplanApiUrl(args.appUrl)
}

export async function itsaplanConnect(args: {
  appUrl: string
  apiUrl?: string
  apiKey: string
}): Promise<ItsaplanResult<{ viewer: ItsaplanViewer }>> {
  const appUrl = normalizeItsaplanAppUrl(args.appUrl)
  if (!appUrl) {
    return { ok: false, error: 'invalidUrl', message: 'Enter a valid http(s) address.' }
  }
  let apiUrl: string
  if (args.apiUrl?.trim()) {
    const normalized = normalizeItsaplanAppUrl(args.apiUrl)
    if (!normalized) {
      return { ok: false, error: 'invalidUrl', message: 'Enter a valid API address.' }
    }
    apiUrl = normalized
  } else {
    const detected = await detectItsaplanApiUrl(appUrl)
    if (!detected.ok) {
      return detected
    }
    apiUrl = detected.apiUrl
  }
  const apiKey = args.apiKey.trim()
  const verified = await verifyItsaplanKey(apiUrl, apiKey)
  if (!verified.ok) {
    return verified
  }
  const instance = { id: itsaplanInstanceIdForApiUrl(apiUrl), appUrl, apiUrl }
  await saveItsaplanInstance(instance, apiKey)
  clearItsaplanProjectCaches()
  cachedViewer = { instanceId: instance.id, viewer: verified.viewer }
  return verified
}

export async function itsaplanDisconnect(): Promise<void> {
  await clearItsaplanInstance()
  clearItsaplanProjectCaches()
  cachedViewer = null
}

export async function itsaplanTestConnection(): Promise<
  ItsaplanResult<{ viewer: ItsaplanViewer }>
> {
  const instance = readItsaplanInstance()
  if (!instance) {
    return { ok: false, error: 'notConnected', message: 'It’s a Plan is not connected.' }
  }
  let apiKey: string | null = null
  try {
    apiKey = readItsaplanApiKey(instance.id)
  } catch {}
  if (!apiKey) {
    return { ok: false, error: 'invalidApiKey', message: 'API key invalid, reconnect.' }
  }
  const result = await verifyItsaplanKey(instance.apiUrl, apiKey)
  if (result.ok) {
    cachedViewer = { instanceId: instance.id, viewer: result.viewer }
  }
  return result
}

export async function itsaplanGetViewer(): Promise<ItsaplanViewer | null> {
  const instance = readItsaplanInstance()
  if (!instance) {
    return null
  }
  if (cachedViewer?.instanceId === instance.id) {
    return cachedViewer.viewer
  }
  const result = await itsaplanTestConnection()
  return result.ok ? result.viewer : null
}

/** The viewer id behind the "me" assignee filter. */
export async function itsaplanRequireViewerId(): Promise<string> {
  const viewer = await itsaplanGetViewer()
  if (!viewer) {
    throw new ItsaplanApiError('invalidApiKey')
  }
  return viewer.id
}

export async function itsaplanStatus(): Promise<ItsaplanConnectionStatus> {
  const instance = readItsaplanInstance()
  const credentialError = getItsaplanCredentialError()
  if (!instance) {
    return {
      connected: false,
      viewer: null,
      instance: null,
      ...(credentialError ? { credentialError } : {})
    }
  }
  return {
    connected: true,
    viewer: await itsaplanGetViewer(),
    instance,
    ...(credentialError ? { credentialError } : {}),
    credentialProtection: getItsaplanCredentialProtection()
  }
}
