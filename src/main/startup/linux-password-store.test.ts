import { describe, expect, it } from 'vitest'
import { resolveLinuxPasswordStore } from './linux-password-store'

const SESSION_BUS = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }

function resolve(
  env: NodeJS.ProcessEnv,
  passwordStoreAlreadySet = false
): ReturnType<typeof resolveLinuxPasswordStore> {
  return resolveLinuxPasswordStore(env, { passwordStoreAlreadySet })
}

describe('resolveLinuxPasswordStore', () => {
  it('selects libsecret on compositors Chromium cannot detect', () => {
    // Repro for the Hyprland case: gnome-keyring running the whole time, but
    // safeStorage reports unavailable and every store writes plaintext.
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'Hyprland' })).toBe('gnome-libsecret')
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'sway' })).toBe('gnome-libsecret')
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'niri' })).toBe('gnome-libsecret')
  })

  it('leaves detected desktops on their existing backend', () => {
    // Why this matters: these machines already have secrets sealed under the
    // detected backend. Naming a different one would strand every one of them.
    for (const desktop of ['GNOME', 'KDE', 'XFCE', 'ubuntu:GNOME', 'X-Cinnamon:Cinnamon']) {
      expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: desktop })).toBeNull()
    }
  })

  it('matches desktop names case-insensitively and inside a colon list', () => {
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'gnome' })).toBeNull()
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'pop:GNOME' })).toBeNull()
  })

  // Why no kwallet branch: this only runs where Chromium failed to detect the
  // desktop, and a real Plasma session reports XDG_CURRENT_DESKTOP=KDE, which it
  // does detect. KDE also serves the freedesktop Secret Service through
  // org.kde.secretservicecompat, so libsecret reaches it on the rare session
  // that sets the KDE variables under an unrecognised compositor.
  it('still selects libsecret when KDE variables appear under an unknown desktop', () => {
    expect(
      resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'Hyprland', KDE_FULL_SESSION: 'true' })
    ).toBe('gnome-libsecret')
    expect(
      resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'wayfire', KDE_SESSION_VERSION: '6' })
    ).toBe('gnome-libsecret')
  })

  it('defers to an explicitly requested store', () => {
    // E2E runs pass --password-store=basic on purpose.
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'Hyprland' }, true)).toBeNull()
  })

  it('does nothing without a session bus to reach', () => {
    expect(resolve({ XDG_CURRENT_DESKTOP: 'Hyprland' })).toBeNull()
    expect(resolve({ XDG_CURRENT_DESKTOP: 'Hyprland', XDG_RUNTIME_DIR: '   ' })).toBeNull()
  })

  it('accepts XDG_RUNTIME_DIR as the session-bus signal', () => {
    expect(resolve({ XDG_CURRENT_DESKTOP: 'Hyprland', XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(
      'gnome-libsecret'
    )
  })

  it('selects libsecret when the desktop is unset entirely', () => {
    expect(resolve({ ...SESSION_BUS })).toBe('gnome-libsecret')
  })
})
