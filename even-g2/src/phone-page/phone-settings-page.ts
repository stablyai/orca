// Unit 7: phone-side pairing/settings page (spec S6 "Pairing UX"). Framework-free DOM
// controller — the phone page is one settings/pairing form, not a HUD screen.
//
// Binds to interfaces only so this compiles and tests standalone while Units 3/8 land
// concurrently:
//   - `store`: minimal HostProfileStore surface (Unit 3 owns the concrete impl).
//   - `parsePairingCode`: injected parser (Unit 3's pairing-code-decode.ts); default
//     undefined — until wired, pasted codes are reported as unavailable rather than parsed.
//   - `probeConnect`: injected connection probe (Unit 8 wires OrcaSocketClient); default
//     no-op success so the form is usable stand-alone in dev/tests.
import type { GlassesHostProfile } from '../state/hud-store'

// Local subset of Unit 3's PairingOffer (mirrors @orca-shared/mobile-relay-pairing-offer's
// PairingOffer) — only the fields this page reads, to avoid a hard import dependency.
export type PairingOffer = {
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  pairedDeviceId?: string
}

// Minimal injected interface for Unit 3's HostProfileStore, typed locally to avoid a hard
// dependency during concurrent build; the integrator wires the real class in.
export type HostProfileStorePort = {
  load(): Promise<GlassesHostProfile[]>
  upsert(profile: GlassesHostProfile): Promise<void>
  remove(id: string): Promise<void>
}

export type ProbeConnectResult = { ok: true } | { ok: false; error: string }
export type ProbeConnect = (offer: PairingOffer) => Promise<ProbeConnectResult>

export type PhoneSettingsPageOptions = {
  store: HostProfileStorePort
  parsePairingCode?: (input: string) => PairingOffer | null
  probeConnect?: ProbeConnect
  now?: () => number
}

export type PhoneSettingsPage = {
  mount(el: HTMLElement): void
  unmount(): void
}

// FNV-1a: a small, dependency-free, deterministic hash — not cryptographic, just needs to be
// stable and non-secret (finding: device token in DOM). Collisions would only ever cause two
// distinct hosts lacking pairedDeviceId to share a profile id, which upsert()'s last-write-wins
// semantics already tolerate safely.
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// Never derive the id from deviceToken (finding: it lands in DOM via data-host-id and would be
// exposed/inspectable) — hash the non-secret endpoint+publicKeyB64 instead when the offer has
// no pairedDeviceId.
function hostIdFromOffer(offer: PairingOffer): string {
  return offer.pairedDeviceId ?? `host-${fnv1aHex(`${offer.endpoint}|${offer.publicKeyB64}`)}`
}

function hostNameFromOffer(offer: PairingOffer): string {
  return offer.pairedDeviceId ?? offer.endpoint
}

export function createPhoneSettingsPage(opts: PhoneSettingsPageOptions): PhoneSettingsPage {
  const { store, parsePairingCode, now = Date.now } = opts
  const probeConnect: ProbeConnect = opts.probeConnect ?? (async () => ({ ok: true }))

  let root: HTMLElement | null = null
  let logEl: HTMLElement | null = null
  let hostListEl: HTMLElement | null = null
  let form: HTMLFormElement | null = null
  let codeInput: HTMLTextAreaElement | null = null
  let submitBtn: HTMLButtonElement | null = null

  function log(line: string): void {
    if (!logEl) {
      return
    }
    const row = document.createElement('div')
    row.className = 'phone-log-row'
    row.textContent = `[${new Date(now()).toLocaleTimeString()}] ${line}`
    logEl.appendChild(row)
    logEl.scrollTop = logEl.scrollHeight
  }

  function buildHostRow(host: GlassesHostProfile): HTMLElement {
    const row = document.createElement('div')
    row.className = 'phone-host-row'
    row.dataset.hostId = host.id

    const label = document.createElement('span')
    label.className = 'phone-host-label'
    label.textContent = `${host.name} — ${host.endpoint}`
    row.appendChild(label)

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'phone-host-remove'
    removeBtn.textContent = 'Remove'
    removeBtn.addEventListener('click', () => void handleRemove(host))
    row.appendChild(removeBtn)

    return row
  }

  async function handleRemove(host: GlassesHostProfile): Promise<void> {
    await store.remove(host.id)
    log(`Removed host "${host.name}".`)
    await renderHosts()
  }

  async function renderHosts(): Promise<void> {
    if (!hostListEl) {
      return
    }
    const hosts = await store.load()
    hostListEl.replaceChildren()
    if (hosts.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'phone-hosts-empty'
      empty.textContent = 'No paired hosts yet.'
      hostListEl.appendChild(empty)
      return
    }
    for (const host of hosts) {
      hostListEl.appendChild(buildHostRow(host))
    }
  }

  async function handleSubmit(ev: Event): Promise<void> {
    ev.preventDefault()
    if (!codeInput || !submitBtn) {
      return
    }
    const raw = codeInput.value.trim()
    if (!raw) {
      log('Paste a pairing code first.')
      return
    }

    if (!parsePairingCode) {
      log('Pairing is not available yet — try again shortly.')
      return
    }

    const offer = parsePairingCode(raw)
    if (!offer) {
      log('Invalid pairing code — could not parse.')
      return
    }

    submitBtn.disabled = true
    log('Parsed pairing code. Probing connection...')
    try {
      const result = await probeConnect(offer)
      if (!result.ok) {
        log(`Connection failed: ${result.error}`)
        return
      }
      const profile: GlassesHostProfile = {
        id: hostIdFromOffer(offer),
        name: hostNameFromOffer(offer),
        endpoint: offer.endpoint,
        deviceToken: offer.deviceToken,
        publicKeyB64: offer.publicKeyB64,
        lastConnected: now()
      }
      await store.upsert(profile)
      log(`Paired with "${profile.name}".`)
      codeInput.value = ''
      await renderHosts()
    } finally {
      submitBtn.disabled = false
    }
  }

  function buildDom(): HTMLElement {
    const page = document.createElement('div')
    page.className = 'phone-settings-page'

    const heading = document.createElement('h1')
    heading.textContent = 'Pair with Orca'
    page.appendChild(heading)

    const instructions = document.createElement('p')
    instructions.className = 'phone-instructions'
    instructions.textContent = 'On your Orca desktop, generate a pairing code and paste it below.'
    page.appendChild(instructions)

    form = document.createElement('form')
    form.className = 'phone-pair-form'
    form.addEventListener('submit', (ev) => void handleSubmit(ev))

    codeInput = document.createElement('textarea')
    codeInput.className = 'phone-pair-input'
    codeInput.rows = 3
    codeInput.placeholder = 'orca://pair?code=...'
    codeInput.setAttribute('aria-label', 'Pairing code')
    form.appendChild(codeInput)

    submitBtn = document.createElement('button')
    submitBtn.type = 'submit'
    submitBtn.textContent = 'Pair'
    form.appendChild(submitBtn)

    page.appendChild(form)

    const hostsHeading = document.createElement('h2')
    hostsHeading.textContent = 'Paired hosts'
    page.appendChild(hostsHeading)

    hostListEl = document.createElement('div')
    hostListEl.className = 'phone-host-list'
    page.appendChild(hostListEl)

    const logHeading = document.createElement('h2')
    logHeading.textContent = 'Connection log'
    page.appendChild(logHeading)

    logEl = document.createElement('div')
    logEl.className = 'phone-log'
    page.appendChild(logEl)

    return page
  }

  return {
    mount(el: HTMLElement): void {
      root = buildDom()
      el.appendChild(root)
      void renderHosts()
    },
    unmount(): void {
      root?.parentElement?.removeChild(root)
      root = null
      logEl = null
      hostListEl = null
      form = null
      codeInput = null
      submitBtn = null
    }
  }
}
