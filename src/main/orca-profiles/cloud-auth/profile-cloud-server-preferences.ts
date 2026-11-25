import {
  DEFAULT_CLOUD_SERVER,
  type CustomCloudServerSettings
} from '../../../shared/settings/custom-cloud-server'

let readCustomServer: () => CustomCloudServerSettings | undefined = () => undefined

export function installCloudServerSettingsReader(reader: typeof readCustomServer): void {
  readCustomServer = reader
}

export function getSavedCloudServerSettings(): CustomCloudServerSettings | undefined {
  return readCustomServer()
}

export function requiresExplicitCloudServiceUrl(
  config: { apiBaseUrl: string; clientId: string; relayDirectorUrl: string },
  override?: string | null
): boolean {
  return (
    !override?.trim() &&
    (config.apiBaseUrl !== DEFAULT_CLOUD_SERVER.authServerUrl ||
      config.clientId !== DEFAULT_CLOUD_SERVER.clientId ||
      config.relayDirectorUrl !== DEFAULT_CLOUD_SERVER.relayDirectorUrl)
  )
}
