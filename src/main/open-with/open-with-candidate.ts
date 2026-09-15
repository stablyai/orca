import type { ShellOpenWithApplication } from '../../shared/shell-open-types'

export type OpenWithLaunchSpec =
  | { kind: 'windows-command'; command: string }
  | { kind: 'windows-chooser' }
  | { kind: 'macos-application'; applicationPath: string }
  | { kind: 'linux-desktop-entry'; execTokens: string[] }

export type OpenWithApplicationCandidate = ShellOpenWithApplication & {
  launch: OpenWithLaunchSpec
}
