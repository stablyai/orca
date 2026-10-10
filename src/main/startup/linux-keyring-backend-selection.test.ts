import { describe, expect, it, vi } from 'vitest'
import {
  identifiesResolvedDesktop,
  resolveLinuxPasswordStore,
  type SecretServiceCollectionState
} from './linux-keyring-backend-selection'

const SESSION_BUS = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }

function resolve(
  env: NodeJS.ProcessEnv,
  collection: SecretServiceCollectionState = 'unlocked',
  passwordStoreAlreadySelected = false
) {
  const probeCollection = vi.fn(() => collection)
  const decision = resolveLinuxPasswordStore({
    env: { ...SESSION_BUS, ...env },
    passwordStoreAlreadySelected,
    probeCollection
  })
  return { ...decision, probeCollection }
}

describe('identifiesResolvedDesktop', () => {
  it.each([
    'GNOME',
    'gnome',
    'GNOME:ubuntu',
    'ubuntu:GNOME',
    'X-Cinnamon',
    'KDE',
    'XFCE',
    'Pantheon',
    'UKUI',
    'Deepin',
    'unity',
    // Chromium identifies LXQt and then picks basic_text for it. That is still a
    // resolved desktop, and overriding a deliberate choice is not this fix's job.
    'LXQt'
  ])('treats %s as a desktop Chromium resolves', (desktop) => {
    expect(identifiesResolvedDesktop({ XDG_CURRENT_DESKTOP: desktop })).toBe(true)
  })

  it.each(['Hyprland', 'sway', 'river', 'niri', '', 'wlroots:custom'])(
    'treats %s as unrecognised',
    (desktop) => {
      expect(identifiesResolvedDesktop({ XDG_CURRENT_DESKTOP: desktop })).toBe(false)
    }
  )

  it('reads the DESKTOP_SESSION fallback Chromium also consults', () => {
    expect(
      identifiesResolvedDesktop({ XDG_CURRENT_DESKTOP: 'Hyprland', DESKTOP_SESSION: 'plasma' })
    ).toBe(true)
  })

  // Why this case has its own test: missing it is what would strand sealed credentials.
  // A KDE session identified only by KDE_FULL_SESSION gets kwallet from Chromium, and
  // overriding that with libsecret makes every existing secret unreadable.
  it.each(['GNOME_DESKTOP_SESSION_ID', 'KDE_FULL_SESSION', 'KDE_SESSION_VERSION'])(
    'treats a bare %s as identifying a desktop',
    (variable) => {
      expect(identifiesResolvedDesktop({ XDG_CURRENT_DESKTOP: 'Hyprland', [variable]: '1' })).toBe(
        true
      )
    }
  )

  it('ignores a presence variable that is set but empty', () => {
    expect(
      identifiesResolvedDesktop({ XDG_CURRENT_DESKTOP: 'Hyprland', KDE_FULL_SESSION: '  ' })
    ).toBe(false)
  })
})

describe('resolveLinuxPasswordStore', () => {
  it('selects libsecret on an unrecognised desktop with an unlocked secret service', () => {
    expect(resolve({ XDG_CURRENT_DESKTOP: 'Hyprland' }).store).toBe('gnome-libsecret')
  })

  it('leaves a resolved desktop alone without probing at all', () => {
    const { store, probeCollection } = resolve({ XDG_CURRENT_DESKTOP: 'GNOME' })
    expect(store).toBeNull()
    expect(probeCollection).not.toHaveBeenCalled()
  })

  // Why this is the whole point of the design: selecting libsecret against a locked
  // collection with no prompter is what made isEncryptionAvailable() block for 76s to
  // first window (STA-5765). Plaintext plus an accurate warning beats a frozen app.
  it('declines to select a locked secret service rather than risk a startup stall', () => {
    const { store, reason } = resolve({ XDG_CURRENT_DESKTOP: 'sway' }, 'locked')
    expect(store).toBeNull()
    expect(reason).toMatch(/locked/)
  })

  it('declines when no secret service answers', () => {
    expect(resolve({ XDG_CURRENT_DESKTOP: 'river' }, 'unavailable').store).toBeNull()
  })

  it('defers to an explicit --password-store without probing', () => {
    const { store, probeCollection } = resolve({ XDG_CURRENT_DESKTOP: 'niri' }, 'unlocked', true)
    expect(store).toBeNull()
    expect(probeCollection).not.toHaveBeenCalled()
  })

  it('does not probe when there is no session bus to probe', () => {
    const probeCollection = vi.fn((): SecretServiceCollectionState => 'unlocked')
    const decision = resolveLinuxPasswordStore({
      env: { XDG_CURRENT_DESKTOP: 'Hyprland' },
      passwordStoreAlreadySelected: false,
      probeCollection
    })
    expect(decision.store).toBeNull()
    expect(probeCollection).not.toHaveBeenCalled()
  })

  it('treats an empty session bus address as no session bus', () => {
    const probeCollection = vi.fn((): SecretServiceCollectionState => 'unlocked')
    resolveLinuxPasswordStore({
      env: { XDG_CURRENT_DESKTOP: 'Hyprland', DBUS_SESSION_BUS_ADDRESS: '   ' },
      passwordStoreAlreadySelected: false,
      probeCollection
    })
    expect(probeCollection).not.toHaveBeenCalled()
  })

  it('gives a reason for every outcome, since the log line is the only trace', () => {
    for (const collection of ['unlocked', 'locked', 'unavailable'] as const) {
      expect(resolve({ XDG_CURRENT_DESKTOP: 'Hyprland' }, collection).reason).not.toBe('')
    }
  })
})
