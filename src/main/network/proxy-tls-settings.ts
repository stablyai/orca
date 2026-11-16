import { X509Certificate } from 'node:crypto'
import { getCACertificates, type ConnectionOptions } from 'node:tls'
import type {
  NetworkProxySettings,
  NetworkProxyTlsSettings
} from '../../shared/network/network-proxy'
import type { ProxySession } from './electron-default-proxy-session'
import { closeProxySessionConnections } from './proxy-session-connections'

export type ProxyTlsSettings = {
  certificate: string
  ignoreErrors: boolean
  options: Pick<ConnectionOptions, 'ca' | 'rejectUnauthorized'>
}

let tlsBySession = new WeakMap<ProxySession, ProxyTlsSettings>()

export function getProxySessionTlsSettings(session: ProxySession): ProxyTlsSettings | null {
  return tlsBySession.get(session) ?? null
}

export function resetProxyTlsSettingsForTests(session?: ProxySession): void {
  if (session) {
    tlsBySession.delete(session)
  } else {
    tlsBySession = new WeakMap()
  }
}

export function sanitizeProxyTlsSettingsUpdate(
  settings: NetworkProxySettings
): NetworkProxyTlsSettings {
  return {
    ...('httpProxyCaCertificate' in settings
      ? {
          httpProxyCaCertificate: validateProxyCaCertificate(settings.httpProxyCaCertificate)
        }
      : {}),
    ...('httpProxyIgnoreCertificateErrors' in settings
      ? {
          httpProxyIgnoreCertificateErrors: settings.httpProxyIgnoreCertificateErrors === true
        }
      : {})
  }
}

export async function applyProxyTlsSettings(
  session: ProxySession,
  settings: NetworkProxySettings
): Promise<void> {
  const tls = resolveProxyTlsSettings(settings)
  const previous = tlsBySession.get(session)
  if (
    tls.certificate === (previous?.certificate ?? '') &&
    tls.ignoreErrors === (previous?.ignoreErrors ?? false)
  ) {
    return
  }
  closeProxySessionConnections(session)
  await session.closeAllConnections?.()
  tlsBySession.set(session, tls)
}

export function validateProxyCaCertificate(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return ''
  }
  if (typeof value !== 'string' || value.length > 1024 * 1024) {
    throw new Error('CA certificate must be PEM text under 1 MiB.')
  }
  const pem = value.trim()
  if (!pem) {
    return ''
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
  if (!blocks?.length || blocks.join('').replace(/\s/g, '') !== pem.replace(/\s/g, '')) {
    throw new Error('Enter PEM CA certificates only, without private keys.')
  }
  try {
    for (const block of blocks) {
      if (!new X509Certificate(block).ca) {
        throw new Error('Not a CA')
      }
    }
  } catch {
    throw new Error('Enter a valid PEM CA certificate.')
  }
  return pem
}

export function resolveProxyTlsSettings(settings: NetworkProxySettings): ProxyTlsSettings {
  const certificate = validateProxyCaCertificate(settings.httpProxyCaCertificate)
  const ignoreErrors = settings.httpProxyIgnoreCertificateErrors === true
  return {
    certificate,
    ignoreErrors,
    options: {
      ...(certificate ? { ca: [...getCACertificates('default'), certificate] } : {}),
      ...(certificate || ignoreErrors ? { rejectUnauthorized: !ignoreErrors } : {})
    }
  }
}
