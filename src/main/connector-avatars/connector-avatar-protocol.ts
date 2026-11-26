import { join } from 'node:path'
import { protocol } from 'electron'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { CONNECTOR_AVATAR_SCHEME, connectorAvatarUrlOf } from '../../shared/connector-avatar-scheme'
import { fetchWithElectronManualRedirects } from '../host/electron-manual-redirect-fetch'
import { ConnectorAvatarCache } from './connector-avatar-cache'

export const CONNECTOR_AVATAR_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: CONNECTOR_AVATAR_SCHEME,
  privileges: { standard: true, secure: true }
}

const cache = new ConnectorAvatarCache({
  directory: () => join(getAppEnvironment().getPath('userData'), 'connector-avatars'),
  fetch: fetchWithElectronManualRedirects,
  now: Date.now
})

export async function handleConnectorAvatarRequest(
  request: Request,
  avatars: Pick<ConnectorAvatarCache, 'read'> = cache
): Promise<Response> {
  const url = connectorAvatarUrlOf(request.url)
  if (!url) {
    return new Response(null, { status: 404 })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405 })
  }
  const image = await avatars.read(url).catch(() => null)
  if (!image) {
    return new Response(null, { status: 404 })
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(image.data), {
    headers: {
      'Content-Type': image.mimeType,
      'Content-Length': String(image.data.byteLength),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

export function installConnectorAvatarProtocolHandler(): void {
  protocol.handle(CONNECTOR_AVATAR_SCHEME, (request) => handleConnectorAvatarRequest(request))
}
