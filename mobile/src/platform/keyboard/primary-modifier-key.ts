import { hostOs } from '../host-os'

/** The submit chord's modifier: Cmd on an Apple keyboard (iPhone, iPad, Mac), Ctrl elsewhere. */
export function primaryModifierKey(): 'Meta' | 'Control' {
  const os = hostOs()
  return os === 'ios' || os === 'macos' ? 'Meta' : 'Control'
}
