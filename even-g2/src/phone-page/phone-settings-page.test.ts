import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlassesHostProfile } from '../state/hud-store'
import {
  createPhoneSettingsPage,
  type HostProfileStorePort,
  type PairingOffer,
  type ProbeConnectResult
} from './phone-settings-page'

function fakeStore(initial: GlassesHostProfile[] = []): HostProfileStorePort {
  let hosts = [...initial]
  return {
    load: vi.fn(async () => [...hosts]),
    upsert: vi.fn(async (profile: GlassesHostProfile) => {
      hosts = [...hosts.filter((h) => h.id !== profile.id), profile]
    }),
    remove: vi.fn(async (id: string) => {
      hosts = hosts.filter((h) => h.id !== id)
    })
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createPhoneSettingsPage', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  it('mount renders the pairing form and empty host list', async () => {
    const page = createPhoneSettingsPage({ store: fakeStore() })
    page.mount(container)
    await flush()

    expect(container.querySelector('form.phone-pair-form')).not.toBeNull()
    expect(container.querySelector('textarea')).not.toBeNull()
    expect(container.querySelector('.phone-hosts-empty')?.textContent).toBe('No paired hosts yet.')
  })

  it('pasting a valid code calls parse, probe, and store.upsert', async () => {
    const store = fakeStore()
    const offer: PairingOffer = {
      endpoint: 'ws://192.168.1.5:6768',
      deviceToken: 'tok-123',
      publicKeyB64: `${'a'.repeat(43)}=`
    }
    const parsePairingCode = vi.fn((input: string) => (input === 'good-code' ? offer : null))
    const probeConnect = vi.fn(async (): Promise<ProbeConnectResult> => ({ ok: true }))

    const page = createPhoneSettingsPage({ store, parsePairingCode, probeConnect })
    page.mount(container)
    await flush()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const form = container.querySelector('form') as HTMLFormElement
    textarea.value = 'good-code'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()

    expect(parsePairingCode).toHaveBeenCalledWith('good-code')
    expect(probeConnect).toHaveBeenCalledWith(offer)
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: offer.endpoint,
        deviceToken: offer.deviceToken,
        publicKeyB64: offer.publicKeyB64
      })
    )
    expect(container.querySelector('.phone-hosts-empty')).toBeNull()
    expect(container.textContent).toContain('Paired with')
  })

  it('remove button calls store.remove and re-renders the list', async () => {
    const host: GlassesHostProfile = {
      id: 'host-1',
      name: 'desk',
      endpoint: 'ws://10.0.0.1:6768',
      deviceToken: 'tok',
      publicKeyB64: `${'b'.repeat(43)}=`,
      lastConnected: 0
    }
    const store = fakeStore([host])
    const page = createPhoneSettingsPage({ store })
    page.mount(container)
    await flush()

    expect(container.querySelector('.phone-host-row')).not.toBeNull()

    const removeBtn = container.querySelector('.phone-host-remove') as HTMLButtonElement
    removeBtn.click()
    await flush()

    expect(store.remove).toHaveBeenCalledWith('host-1')
    expect(container.querySelector('.phone-host-row')).toBeNull()
    expect(container.querySelector('.phone-hosts-empty')).not.toBeNull()
  })

  it('invalid code shows an error in the log and does not call store.upsert', async () => {
    const store = fakeStore()
    const parsePairingCode = vi.fn(() => null)
    const page = createPhoneSettingsPage({ store, parsePairingCode })
    page.mount(container)
    await flush()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const form = container.querySelector('form') as HTMLFormElement
    textarea.value = 'garbage'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()

    expect(parsePairingCode).toHaveBeenCalledWith('garbage')
    expect(store.upsert).not.toHaveBeenCalled()
    expect(container.querySelector('.phone-log')?.textContent).toContain('Invalid pairing code')
  })

  it('shows an "unavailable" log message when parsePairingCode is not wired', async () => {
    const store = fakeStore()
    const page = createPhoneSettingsPage({ store })
    page.mount(container)
    await flush()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const form = container.querySelector('form') as HTMLFormElement
    textarea.value = 'orca://pair?code=abc'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()

    expect(store.upsert).not.toHaveBeenCalled()
    expect(container.querySelector('.phone-log')?.textContent).toContain('not available yet')
  })

  it('derives a non-secret, stable host id when pairedDeviceId is absent (finding #9)', async () => {
    const store = fakeStore()
    const offer: PairingOffer = {
      endpoint: 'ws://192.168.1.5:6768',
      deviceToken: 'super-secret-token',
      publicKeyB64: `${'c'.repeat(43)}=`
    }
    const parsePairingCode = vi.fn(() => offer)
    const page = createPhoneSettingsPage({
      store,
      parsePairingCode,
      probeConnect: async () => ({ ok: true })
    })
    page.mount(container)
    await flush()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const form = container.querySelector('form') as HTMLFormElement
    textarea.value = 'good-code'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()

    const upserted = (store.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as GlassesHostProfile
    expect(upserted.id).not.toContain(offer.deviceToken)
    expect(upserted.id).toMatch(/^host-[0-9a-f]{8}$/)

    const hostRow = container.querySelector('.phone-host-row') as HTMLElement
    expect(hostRow.dataset.hostId).not.toContain(offer.deviceToken)

    // Stable across separately-parsed offers with the same endpoint+publicKeyB64.
    const store2 = fakeStore()
    const page2 = createPhoneSettingsPage({
      store: store2,
      parsePairingCode: vi.fn(() => offer),
      probeConnect: async () => ({ ok: true })
    })
    const container2 = document.createElement('div')
    document.body.appendChild(container2)
    page2.mount(container2)
    await flush()
    const textarea2 = container2.querySelector('textarea') as HTMLTextAreaElement
    const form2 = container2.querySelector('form') as HTMLFormElement
    textarea2.value = 'good-code'
    form2.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    const upserted2 = (store2.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as GlassesHostProfile
    expect(upserted2.id).toBe(upserted.id)
  })

  it('unmount removes the DOM and stops future interaction', async () => {
    const store = fakeStore()
    const page = createPhoneSettingsPage({ store })
    page.mount(container)
    await flush()
    expect(container.children.length).toBeGreaterThan(0)

    page.unmount()
    expect(container.children.length).toBe(0)
  })
})
