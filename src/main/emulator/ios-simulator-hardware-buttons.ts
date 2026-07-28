import { EmulatorError } from './emulator-errors'

export type IosHardwareButton = 'home' | 'lock' | 'siri' | 'app_switcher' | 'swipe_home'

// Why: `side_button` reached serve-sim unchanged and silently did nothing — on every
// Face ID and Touch ID iPhone the side button is the sleep/wake (lock) button, which
// is also what Simulator.app's Device > Side Button does. Remaining aliases mirror
// android-input-mapping so one agent vocabulary drives both backends.
const BUTTON_ALIASES = new Map<string, IosHardwareButton>([
  ['home', 'home'],
  ['home_button', 'home'],
  ['lock', 'lock'],
  ['side_button', 'lock'],
  ['power', 'lock'],
  ['siri', 'siri'],
  ['app_switcher', 'app_switcher'],
  ['app_switch', 'app_switcher'],
  ['recents', 'app_switcher'],
  ['recent', 'app_switcher'],
  ['overview', 'app_switcher'],
  ['swipe_home', 'swipe_home']
])

const ACCEPTED_BUTTON_NAMES = 'home, lock, side_button, siri, app_switcher, swipe_home'

// Accepts the canonical serve-sim names plus the aliases above. Throws
// EmulatorError('emulator_error', ...) on an unknown name, because serve-sim
// accepts anything and exits 0 instead of reporting the name back.
export function resolveIosHardwareButton(name: string): IosHardwareButton {
  const button = BUTTON_ALIASES.get(name.trim().toLowerCase())
  if (!button) {
    throw new EmulatorError(
      'emulator_error',
      `Unknown iOS hardware button: ${name}. Expected one of: ${ACCEPTED_BUTTON_NAMES}.`
    )
  }
  return button
}
