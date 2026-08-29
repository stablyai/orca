export const GITHUB_WEB_BASE_URL = 'https://github.com'
export const GITHUB_API_BASE_URL = 'https://api.github.com'

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

// Why an env override: a `ORCA_GITHUB_TOKEN` lets headless/CI hosts authenticate
// without keychain access, mirroring Bitbucket's environment credential path.
export function getEnvGitHubToken(): string | null {
  return envValue('ORCA_GITHUB_TOKEN')
}

// Why env + no bundled default: Device Flow needs a first-party OAuth app
// client id (its owner must enable "Device authorization flow"). Orca does not
// ship one yet; `ORCA_GITHUB_CLIENT_ID` unblocks the flow for anyone who
// registers their own OAuth app, and the panel hides device sign-in otherwise
// (PAT sign-in still works).
export function getGitHubDeviceFlowClientId(): string | null {
  return envValue('ORCA_GITHUB_CLIENT_ID')
}
