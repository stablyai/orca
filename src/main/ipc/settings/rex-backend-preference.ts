import type { GlobalSettings } from '../../../shared/settings/global-settings-types'

export function normalizeRexBackendPreference(
  args: Partial<GlobalSettings>,
  target: Partial<GlobalSettings>
): void {
  if ('terminalLocalBackend' in args) {
    target.terminalLocalBackend = args.terminalLocalBackend === 'rex' ? 'rex' : 'default'
  }
}
