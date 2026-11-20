import type { CustomCloudServerSettings } from '../../../shared/settings/custom-cloud-server'

let readCustomServer: () => CustomCloudServerSettings | undefined = () => undefined

export function installCloudServerSettingsReader(reader: typeof readCustomServer): void {
  readCustomServer = reader
}

export function getSavedCloudServerSettings(): CustomCloudServerSettings | undefined {
  return readCustomServer()
}

export function requiresExplicitCloudServiceUrl(override?: string | null): boolean {
  return readCustomServer()?.enabled === true && !override?.trim()
}
