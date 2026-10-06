export type ClaudeManagedAuthLocation = {
  managedAuthPath: string
  managedAuthRuntime: 'host' | 'wsl'
  wslDistro: string | null
  wslLinuxAuthPath: string | null
}

export type ClaudeManagedAuthSnapshot = {
  credentialsJson: string | null
  oauthAccountJson: string | null
}

export type ClaudeManagedAuthTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}
