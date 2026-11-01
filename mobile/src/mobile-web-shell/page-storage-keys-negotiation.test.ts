import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { harness } from './bridge-host-test-harness'
import { clientFrame } from './bridge-host-test-fakes'
import { createPageReadyFrame } from './bridge/bridge-client-init-handshake'
import { versionSchema } from './bridge/bridge-frame-fields'
import { NEGOTIATED_PAGE_STORAGE_KEYS, PAGE_STORAGE_EXACT_KEYS } from './page-storage-keys'

/** The exact keys every page shipped before `storageKeys` refines `init` storage against. */
const LEGACY_EXACT_KEYS = [
  'orca:last-visited-worktree',
  'orca:hostSidebarWidth',
  'orca:hostDockWidth',
  'orca:terminal-accessory-layout',
  'orca:custom-accessory-keys',
  'orca:defaultSessionView',
  'orca:mobileStructuredSendOperations:v1',
  'orca:terminalTextScale',
  'orca:terminalAutocompleteEnabled',
  'orca:terminalLinkOpenMode'
]
const LEGACY_PREFIXES = [
  'orca:pins:',
  'orca:nativeChatTabs:',
  'orca:terminalLiveInputDisabled:',
  'orca:terminalDrafts:'
]
const legacyIsPageStorageKey = (key: string): boolean =>
  key.length <= 256 &&
  (LEGACY_EXACT_KEYS.includes(key) ||
    LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length))
// The older page's `init` storage members, as `BridgeInitStorageSchema` and `storageOversize` read them.
const LegacyInitStorageSchema = z.object({
  storage: z
    .record(z.string().min(1).max(256).refine(legacyIsPageStorageKey), z.string().max(16 * 1024))
    .refine((entries) => Object.keys(entries).length <= 32)
    .optional(),
  storageOversize: z.array(z.string().refine(legacyIsPageStorageKey)).max(32).optional()
})
// The `ready` reader every shell shipped before `storageKeys`.
const LegacyReadySchema = z.object({ v: versionSchema, type: z.literal('ready') })

const SPLIT_KEY = 'orca:terminalSplitLayout'
const STORAGE = { [SPLIT_KEY]: 'stacked', 'orca:pins:host-a': '["wt-1"]' }

function lastInit(posted: readonly string[]): Record<string, unknown> {
  const init = posted
    .map((json): unknown => JSON.parse(json))
    .findLast(
      (frame): frame is Record<string, unknown> =>
        z.object({ type: z.literal('init') }).safeParse(frame).success
    )
  if (init === undefined) {
    throw new Error('no init was posted')
  }
  return init
}

describe('negotiated page storage keys across page and shell versions', () => {
  it('names every key added after the legacy allowlist as negotiated', () => {
    expect(PAGE_STORAGE_EXACT_KEYS.filter((key) => !LEGACY_EXACT_KEYS.includes(key))).toEqual([
      ...NEGOTIATED_PAGE_STORAGE_KEYS
    ])
  })

  it('keeps the split layout out of an older page init, which that page then accepts', () => {
    const bridge = harness({ storage: STORAGE })
    bridge.host.receive(clientFrame({ type: 'ready' }))

    const init = lastInit(bridge.posted)
    expect(LegacyInitStorageSchema.safeParse(init).success).toBe(true)
    expect(init.storage).toEqual({ 'orca:pins:host-a': '["wt-1"]' })
  })

  it('keeps an oversize split layout out of an older page init too', () => {
    const bridge = harness({
      readStorage: () => ({ storage: {}, storageOversize: [SPLIT_KEY] })
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))

    expect(LegacyInitStorageSchema.safeParse(lastInit(bridge.posted)).success).toBe(true)
  })

  it('hands the split layout to a page whose ready names it', () => {
    const bridge = harness({ storage: STORAGE })
    bridge.host.receive(JSON.stringify(createPageReadyFrame()))

    expect(lastInit(bridge.posted).storage).toEqual(STORAGE)
    expect(bridge.frames().some((frame) => frame.type === 'init')).toBe(true)
  })

  it('sends a ready an older shell still reads', () => {
    const ready: unknown = JSON.parse(JSON.stringify(createPageReadyFrame()))
    expect(LegacyReadySchema.safeParse(ready).success).toBe(true)
  })

  it('reads a malformed storageKeys list as none rather than refusing the ready', () => {
    const bridge = harness({ storage: STORAGE })
    bridge.host.receive(clientFrame({ type: 'ready', storageKeys: [SPLIT_KEY, 7] }))

    expect(bridge.pageReadyCount()).toBe(1)
    expect(lastInit(bridge.posted).storage).toEqual({ 'orca:pins:host-a': '["wt-1"]' })
  })

  it('keeps what the page declared across a host rebuild under the same document', () => {
    const first = harness({ storage: STORAGE })
    first.host.receive(JSON.stringify(createPageReadyFrame()))
    const carried = first.host.readSessionBack()

    const rebuilt = harness({ storage: STORAGE, sessionEstablished: true, sessionBack: carried })
    rebuilt.host.publishKeyboardInset(120)
    expect(lastInit(rebuilt.posted).storage).toEqual(STORAGE)
  })

  it('drops the declaration when the next document says ready without one', () => {
    const bridge = harness({ storage: STORAGE })
    bridge.host.receive(JSON.stringify(createPageReadyFrame()))
    bridge.host.receive(clientFrame({ type: 'close' }))
    bridge.host.receive(clientFrame({ type: 'ready' }))

    expect(lastInit(bridge.posted).storage).toEqual({ 'orca:pins:host-a': '["wt-1"]' })
    expect(bridge.host.readSessionBack()).toEqual({ claimed: false })
  })
})
