import { describe, expect, it } from 'vitest'
import { resolveLinuxPasswordStore } from './linux-password-store'

const SESSION_BUS = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }

/** Calls the resolver with the session-bus default every case here relies on. */
function resolve(
  env: NodeJS.ProcessEnv,
  passwordStoreAlreadySet = false
): ReturnType<typeof resolveLinuxPasswordStore> {
  return resolveLinuxPasswordStore(env, { passwordStoreAlreadySet })
}

describe('resolveLinuxPasswordStore', () => {
  it('selects libsecret on sessions Chromium cannot identify', () => {
    // Repro for the Hyprland case: gnome-keyring running the whole time, but
    // safeStorage reports unavailable and every store writes plaintext.
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'Hyprland' })).toBe('gnome-libsecret')
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'sway' })).toBe('gnome-libsecret')
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'niri' })).toBe('gnome-libsecret')
    expect(resolve({ ...SESSION_BUS })).toBe('gnome-libsecret')
  })

  describe('leaves a session Chromium identifies on its own backend', () => {
    // Why each of these matters: where Chromium resolves a desktop it selects a
    // backend, and a secret may already be sealed under it. Overriding that is
    // what makes an existing blob undecryptable.
    it('via XDG_CURRENT_DESKTOP, matched exactly as Chromium spells it', () => {
      for (const desktop of [
        'Unity',
        'Deepin',
        'GNOME',
        'X-Cinnamon',
        'KDE',
        'Pantheon',
        'XFCE',
        'UKUI',
        'LXQt',
        'COSMIC'
      ]) {
        expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: desktop })).toBeNull()
      }
    })

    it('for any recognised member of the colon-separated list', () => {
      expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBeNull()
      expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'pop:GNOME' })).toBeNull()
    })

    it('via DESKTOP_SESSION when XDG_CURRENT_DESKTOP misses', () => {
      for (const session of [
        'deepin',
        'gnome',
        'mate',
        'kde',
        'kde4',
        'kde-plasma',
        'xubuntu',
        'ukui'
      ]) {
        expect(resolve({ ...SESSION_BUS, DESKTOP_SESSION: session })).toBeNull()
      }
      // Chromium substring-matches xfce rather than comparing whole values.
      expect(resolve({ ...SESSION_BUS, DESKTOP_SESSION: 'xfce4' })).toBeNull()
    })

    it('via the legacy GNOME_DESKTOP_SESSION_ID variable', () => {
      expect(
        resolve({
          ...SESSION_BUS,
          XDG_CURRENT_DESKTOP: 'Hyprland',
          GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated'
        })
      ).toBeNull()
    })

    it('via KDE_FULL_SESSION, which selects the kwallet family', () => {
      // Regression guard: this environment resolves to KDE for Chromium even
      // though the compositor is unrecognised. Forcing libsecret here would
      // strand every v11 secret already sealed under kwallet.
      expect(
        resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'Hyprland', KDE_FULL_SESSION: 'true' })
      ).toBeNull()
      expect(
        resolve({
          ...SESSION_BUS,
          XDG_CURRENT_DESKTOP: 'wayfire',
          KDE_FULL_SESSION: 'true',
          KDE_SESSION_VERSION: '6'
        })
      ).toBeNull()
    })
  })

  it('does not match a desktop on casing Chromium would reject', () => {
    // Chromium compares case-sensitively, so these are unidentified sessions
    // and must get the fix rather than be mistaken for real desktops.
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'gnome' })).toBe('gnome-libsecret')
    expect(resolve({ ...SESSION_BUS, XDG_CURRENT_DESKTOP: 'CINNAMON' })).toBe('gnome-libsecret')
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
})
