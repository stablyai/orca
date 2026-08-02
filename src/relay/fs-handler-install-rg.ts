import {
  buildInstallRgMessage as buildSharedInstallRgMessage,
  detectInstallCommand,
  detectLinuxInstallCommandFromOsRelease
} from '../shared/quick-open-install-rg'

export { detectInstallCommand, detectLinuxInstallCommandFromOsRelease }

export function buildInstallRgMessage(cause: unknown): Promise<string> {
  return buildSharedInstallRgMessage(cause, 'remote')
}
