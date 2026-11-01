import type { CliInstallStatus } from '../../shared/cli-install-types'

export type CliApi = {
  getInstallStatus: () => Promise<CliInstallStatus>
  install: () => Promise<CliInstallStatus>
  remove: () => Promise<CliInstallStatus>
  /** `wakeWslDistro`: a user act (the refresh button) that may start a stopped distro. */
  getWslInstallStatus: (args?: {
    distro?: string | null
    wakeWslDistro?: boolean
  }) => Promise<CliInstallStatus>
  installWsl: (args?: { distro?: string | null }) => Promise<CliInstallStatus>
  removeWsl: (args?: { distro?: string | null }) => Promise<CliInstallStatus>
}
