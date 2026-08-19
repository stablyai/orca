import { readWindowsRegistryEnvironmentValue } from '../windows-environment-registry'

export function readGiteaAuthEnvValue(name: string): string | null {
  const value = (readWindowsRegistryEnvironmentValue(name) ?? process.env[name])?.trim() ?? ''
  return value.length > 0 ? value : null
}
