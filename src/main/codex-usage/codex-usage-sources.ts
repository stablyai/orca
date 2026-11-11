export type CodexUsageSource = {
  directory: string
  distro: string
}

export type CodexUsageSourceDiscovery = {
  sources: CodexUsageSource[]
  wslHomes: string[]
  complete: boolean
}
