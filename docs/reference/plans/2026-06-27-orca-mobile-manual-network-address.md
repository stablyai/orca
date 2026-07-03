# Manual Network Address Entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users type a custom IPv4 address or Tailscale MagicDNS hostname into the desktop mobile-pairing Network Interface dropdown, so the QR code can target a host the OS hasn't auto-discovered.

**Architecture:** Replace the inner `Select` of `MobileNetworkInterfaceSection` with a `Popover + Command` ("combobox") pattern modeled on the existing `AgentCombobox`. A new shared pure function `parseManualNetworkAddress` enforces the input grammar; a new helper `buildComboboxEntries` builds the row list (filtered interfaces + an optional `Use "<query>"` row). The custom selection is session-scoped.

**Tech Stack:** TypeScript, React 18, shadcn/ui primitives (`Command`, `Popover`, `Button`) from `src/renderer/src/components/ui/`, vitest, `@testing-library/react`. No new dependencies.

**Spec:** [`docs/reference/2026-06-27-orca-mobile-manual-network-address-design.md`](../2026-06-27-orca-mobile-manual-network-address-design.md)

---

## File map

**Create:**
- `src/shared/network/manual-address.ts` — pure parser.
- `src/shared/network/manual-address.test.ts` — parser unit tests.
- `src/renderer/src/components/settings/MobileNetworkInterfaceSection.test.tsx` — UI render tests.

**Modify:**
- `src/renderer/src/components/settings/mobile-network-interface-selection.ts` — swap `mergeForSelect` for `buildComboboxEntries` (or add `buildComboboxEntries` and keep the old one if other call sites exist; confirm with grep before deleting).
- `src/renderer/src/components/settings/mobile-network-interface-selection.test.ts` — replace `mergeForSelect` tests with `buildComboboxEntries` tests.
- `src/renderer/src/components/settings/MobileNetworkInterfaceSection.tsx` — swap `Select` for `Popover + Command`.

**Reference (read-only, do not modify):**
- `src/renderer/src/components/ui/command.tsx` — `Command`, `CommandEmpty`, `CommandInput`, `CommandItem`, `CommandList`, `CommandSeparator`.
- `src/renderer/src/components/ui/popover.tsx` — `Popover`, `PopoverTrigger`, `PopoverContent`.
- `src/renderer/src/components/ui/button.tsx` — `Button`.
- `src/renderer/src/components/agent/AgentCombobox.tsx` — full reference implementation of the controlled cmdk pattern.
- `src/renderer/src/components/agent/agent-combobox-command-state.ts` — `createAgentComboboxCommandState`, `resolveAgentComboboxCommandState`, `updateAgentComboboxCommandValue`.
- `src/renderer/src/components/settings/MobilePairingQrSection.tsx` — consumer of `selectedAddress`; unchanged.

**Out of scope:** mobile-side endpoint override (`mobile/app/pair-scan.tsx`); main-process code; persistent storage of custom addresses; IPv6, ports, non-Tailscale hostnames.

---

## Task 1: Add `parseManualNetworkAddress` (TDD)

**Files:**
- Create: `src/shared/network/manual-address.ts`
- Create: `src/shared/network/manual-address.test.ts`

- [ ] **Step 1: Confirm no existing call site for `mergeForSelect`**

  Run:
  ```bash
  grep -rn "mergeForSelect" src/ docs/ 2>/dev/null
  ```
  Expected: no matches. (If there are matches, stop and update Task 2 to keep `mergeForSelect` and only add `buildComboboxEntries` alongside it.)

- [ ] **Step 2: Write the failing tests**

  Create `src/shared/network/manual-address.test.ts` with this exact content:

  ```ts
  import { describe, it, expect } from 'vitest'
  import { parseManualNetworkAddress } from './manual-address'

  describe('parseManualNetworkAddress', () => {
    describe('IPv4', () => {
      it('accepts canonical IPv4', () => {
        expect(parseManualNetworkAddress('192.168.1.24')).toEqual({
          ok: true,
          address: '192.168.1.24'
        })
        expect(parseManualNetworkAddress('100.64.1.20')).toEqual({
          ok: true,
          address: '100.64.1.20'
        })
      })

      it('accepts boundary IPv4 values', () => {
        expect(parseManualNetworkAddress('0.0.0.0').ok).toBe(true)
        expect(parseManualNetworkAddress('255.255.255.255').ok).toBe(true)
      })

      it('rejects malformed IPv4', () => {
        for (const bad of ['', '   ', '1.2.3', '1.2.3.4.5', '256.0.0.1']) {
          expect(parseManualNetworkAddress(bad)).toEqual({
            ok: false,
            error: 'Enter an IPv4 address or Tailscale MagicDNS hostname'
          })
        }
      })

      it('rejects leading zeros in octets', () => {
        expect(parseManualNetworkAddress('01.02.03.04')).toEqual({
          ok: false,
          error: 'Enter an IPv4 address or Tailscale MagicDNS hostname'
        })
        expect(parseManualNetworkAddress('0.0.0.0').ok).toBe(true)
      })
    })

    describe('Tailscale MagicDNS hostname', () => {
      it('accepts short MagicDNS names', () => {
        expect(parseManualNetworkAddress('my-mac.ts.net')).toEqual({
          ok: true,
          address: 'my-mac.ts.net'
        })
      })

      it('accepts tailnet-qualified MagicDNS names', () => {
        expect(parseManualNetworkAddress('my-mac.tail-abcd.ts.net')).toEqual({
          ok: true,
          address: 'my-mac.tail-abcd.ts.net'
        })
        expect(parseManualNetworkAddress('a.b.c.d.ts.net').ok).toBe(true)
      })

      it('is case-insensitive', () => {
        expect(parseManualNetworkAddress('MY-MAC.TS.NET').ok).toBe(true)
      })

      it('rejects non-Tailscale hostnames', () => {
        for (const bad of ['my-mac', 'my-mac.ts.com', '-foo.ts.net', 'my-mac.com']) {
          expect(parseManualNetworkAddress(bad).ok).toBe(false)
        }
      })
    })

    describe('length and whitespace', () => {
      it('rejects inputs longer than 253 chars', () => {
        const long = `${'a'.repeat(250)}.ts.net`
        expect(long.length).toBeGreaterThan(253)
        expect(parseManualNetworkAddress(long).ok).toBe(false)
      })

      it('trims leading and trailing whitespace before validating', () => {
        expect(parseManualNetworkAddress('  192.168.1.24  ')).toEqual({
          ok: true,
          address: '192.168.1.24'
        })
      })
    })
  })
  ```

- [ ] **Step 3: Run tests to verify they fail**

  Run from repo root:
  ```bash
  pnpm vitest run src/shared/network/manual-address.test.ts
  ```
  Expected: error like `Cannot find module './manual-address'`. This is the failing-test step — do not skip it.

- [ ] **Step 4: Implement `parseManualNetworkAddress`**

  Create `src/shared/network/manual-address.ts` with this exact content:

  ```ts
  // Why: pure shared helper so the same validation runs in renderer
  // today and in any future CLI/main-process caller without duplicating
  // the IPv4 + Tailscale MagicDNS grammar.
  const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
  const IPV4 = `(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}`
  // MagicDNS hostname: lowercase letters/digits/hyphens, dot-separated, ending in .ts.net.
  // Labels may not start or end with a hyphen; max 63 chars per label (DNS limit).
  const MAGICDNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
  const MAGICDNS = `(?:${MAGICDNS_LABEL}\\.)+ts\\.net`

  const HOSTNAME_MAX_LENGTH = 253
  const ERROR_MESSAGE = 'Enter an IPv4 address or Tailscale MagicDNS hostname'

  export type ParseManualAddressResult =
    | { ok: true; address: string }
    | { ok: false; error: string }

  export function parseManualNetworkAddress(input: string): ParseManualAddressResult {
    const trimmed = input.trim()
    if (trimmed === '' || trimmed.length > HOSTNAME_MAX_LENGTH) {
      return { ok: false, error: ERROR_MESSAGE }
    }
    if (/\s/.test(trimmed)) {
      return { ok: false, error: ERROR_MESSAGE }
    }

    const ipv4Regex = new RegExp(`^${IPV4}$`)
    if (ipv4Regex.test(trimmed)) {
      return { ok: true, address: trimmed }
    }

    const magicRegex = new RegExp(`^(?:${MAGICDNS})$`, 'i')
    if (magicRegex.test(trimmed)) {
      return { ok: true, address: trimmed }
    }

    return { ok: false, error: ERROR_MESSAGE }
  }
  ```

- [ ] **Step 5: Run tests to verify they pass**

  Run:
  ```bash
  pnpm vitest run src/shared/network/manual-address.test.ts
  ```
  Expected: all tests pass.

- [ ] **Step 6: Lint and typecheck**

  ```bash
  pnpm lint src/shared/network/
  pnpm typecheck
  ```
  Expected: no errors. Fix any and re-run before continuing.

- [ ] **Step 7: Commit**

  ```bash
  git add src/shared/network/manual-address.ts src/shared/network/manual-address.test.ts
  git commit -m "feat(mobile-pairing): add parseManualNetworkAddress validator"
  ```

---

## Task 2: Replace `mergeForSelect` with `buildComboboxEntries` (TDD)

**Files:**
- Modify: `src/renderer/src/components/settings/mobile-network-interface-selection.ts`
- Modify: `src/renderer/src/components/settings/mobile-network-interface-selection.test.ts`

- [ ] **Step 1: Read the current contents of both files**

  Read the full source of:
  - `src/renderer/src/components/settings/mobile-network-interface-selection.ts`
  - `src/renderer/src/components/settings/mobile-network-interface-selection.test.ts`

  Confirm: `mergeForSelect` is the only exported function besides the `MobileNetworkInterface` type and `selectRefreshedNetworkAddress`. If `selectRefreshedNetworkAddress` is called from `MobileNetworkInterfaceSection.tsx`, keep it.

- [ ] **Step 2: Write the failing tests for `buildComboboxEntries`**

  Replace the entire body of `mobile-network-interface-selection.test.ts` with:

  ```ts
  import { describe, it, expect } from 'vitest'
  import {
    buildComboboxEntries,
    selectRefreshedNetworkAddress,
    type MobileNetworkInterface
  } from './mobile-network-interface-selection'

  const LAN: MobileNetworkInterface = { name: 'en0', address: '192.168.1.24' }
  const TAILNET: MobileNetworkInterface = { name: 'tailscale0', address: '100.64.1.20' }

  describe('buildComboboxEntries', () => {
    it('returns only interface entries when query is empty', () => {
      const entries = buildComboboxEntries([LAN, TAILNET], '')
      expect(entries).toEqual([
        { kind: 'interface', iface: LAN },
        { kind: 'interface', iface: TAILNET }
      ])
    })

    it('filters interfaces by substring on address or name (case-insensitive)', () => {
      const entries = buildComboboxEntries([LAN, TAILNET], 'TAIL')
      expect(entries).toEqual([{ kind: 'interface', iface: TAILNET }])
    })

    it('appends a use-query entry when the query is a valid address not in the list', () => {
      const entries = buildComboboxEntries([LAN, TAILNET], 'my-mac.tail-abcd.ts.net')
      expect(entries).toEqual([
        { kind: 'interface', iface: LAN },
        { kind: 'interface', iface: TAILNET },
        { kind: 'use-query', address: 'my-mac.tail-abcd.ts.net' }
      ])
    })

    it('suppresses use-query when query equals an existing interface address', () => {
      const entries = buildComboboxEntries([LAN, TAILNET], '100.64.1.20')
      expect(entries).toEqual([
        { kind: 'interface', iface: LAN },
        { kind: 'interface', iface: TAILNET }
      ])
    })

    it('returns only use-query when interfaces are empty and query is valid', () => {
      const entries = buildComboboxEntries([], '1.2.3.4')
      expect(entries).toEqual([{ kind: 'use-query', address: '1.2.3.4' }])
    })

    it('omits use-query when query is invalid', () => {
      const entries = buildComboboxEntries([LAN, TAILNET], 'not-an-address')
      expect(entries).toEqual([
        { kind: 'interface', iface: LAN },
        { kind: 'interface', iface: TAILNET }
      ])
    })
  })

  describe('selectRefreshedNetworkAddress', () => {
    // Existing behavior is preserved verbatim from the spec.
    it('keeps the selected address when refresh discovers a new tailnet interface', () => {
      expect(selectRefreshedNetworkAddress(LAN.address, [LAN, TAILNET])).toBe(LAN.address)
    })

    it('selects the first refreshed interface when there is no current address', () => {
      expect(selectRefreshedNetworkAddress(undefined, [TAILNET, LAN])).toBe(TAILNET.address)
    })

    it('prefers a tailnet address when no address is selected yet', () => {
      expect(selectRefreshedNetworkAddress(undefined, [LAN, TAILNET])).toBe(TAILNET.address)
    })

    it('moves to the first refreshed interface when the current address disappeared', () => {
      expect(selectRefreshedNetworkAddress('10.0.0.4', [TAILNET, LAN])).toBe(TAILNET.address)
    })

    it('moves to a tailnet address when the current address disappeared', () => {
      expect(selectRefreshedNetworkAddress('10.0.0.4', [LAN, TAILNET])).toBe(TAILNET.address)
    })

    it('clears the selection when no interfaces are available', () => {
      expect(selectRefreshedNetworkAddress(LAN.address, [])).toBeUndefined()
    })
  })
  ```

- [ ] **Step 3: Run the test file to verify the new tests fail**

  ```bash
  pnpm vitest run src/renderer/src/components/settings/mobile-network-interface-selection.test.ts
  ```
  Expected: `buildComboboxEntries is not a function` (or import error) for the new block; the `selectRefreshedNetworkAddress` block still passes.

- [ ] **Step 4: Rewrite `mobile-network-interface-selection.ts`**

  Replace the entire file with:

  ```ts
  import { isTailnetIPv4Address } from '../../../../shared/tailnet-address'
  import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'

  export type MobileNetworkInterface = {
    name: string
    address: string
  }

  export type ComboboxEntry =
    | { kind: 'interface'; iface: MobileNetworkInterface }
    | { kind: 'use-query'; address: string }

  // Why: the UI needs a single ordered list to render inside CommandList.
  // Behavior branches on whether the query parses as a valid address —
  // valid queries show the full interface list (so users can pivot to an
  // existing interface mid-typing), invalid queries substring-filter and
  // fall back to the full list when nothing matches.
  export function buildComboboxEntries(
    interfaces: readonly MobileNetworkInterface[],
    query: string
  ): readonly ComboboxEntry[] {
    const trimmed = query.trim()
    if (trimmed === '') {
      return interfaces.map((iface) => ({ kind: 'interface' as const, iface }))
    }

    const parsed = parseManualNetworkAddress(trimmed)

    let visible: readonly MobileNetworkInterface[]
    if (parsed.ok) {
      // Valid address: keep every interface visible.
      visible = interfaces
    } else {
      // Invalid: substring-filter; fall back to full list when nothing matches.
      const lowered = trimmed.toLowerCase()
      const filtered = interfaces.filter(
        (iface) =>
          iface.address.toLowerCase().includes(lowered) ||
          iface.name.toLowerCase().includes(lowered)
      )
      visible = filtered.length > 0 ? filtered : interfaces
    }

    const entries: ComboboxEntry[] = visible.map((iface) => ({
      kind: 'interface' as const,
      iface
    }))

    if (parsed.ok && !visible.some((iface) => iface.address === parsed.address)) {
      entries.push({ kind: 'use-query', address: parsed.address })
    }

    return entries
  }

  export function selectRefreshedNetworkAddress(
    currentAddress: string | undefined,
    interfaces: readonly MobileNetworkInterface[]
  ): string | undefined {
    if (interfaces.length === 0) {
      return undefined
    }
    if (currentAddress && interfaces.some((iface) => iface.address === currentAddress)) {
      return currentAddress
    }
    return (
      interfaces.find((iface) => isTailnetIPv4Address(iface.address))?.address ??
      interfaces[0]!.address
    )
  }
  ```

  The relative import paths (`../../../../shared/tailnet-address`, `../../../../shared/network/manual-address`) must match the file's location in the tree. If they don't resolve, adjust based on the existing path style in the same directory (e.g. `../foo` vs `@/foo`).

- [ ] **Step 5: Run the test file to verify everything passes**

  ```bash
  pnpm vitest run src/renderer/src/components/settings/mobile-network-interface-selection.test.ts
  ```
  Expected: all tests pass.

- [ ] **Step 6: Lint and typecheck**

  ```bash
  pnpm lint src/renderer/src/components/settings/mobile-network-interface-selection.ts
  pnpm typecheck
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add src/renderer/src/components/settings/mobile-network-interface-selection.ts \
          src/renderer/src/components/settings/mobile-network-interface-selection.test.ts
  git commit -m "feat(mobile-pairing): buildComboboxEntries for network interface combobox"
  ```

---

## Task 3: Rewrite `MobileNetworkInterfaceSection` UI to use Popover + Command

**Files:**
- Modify: `src/renderer/src/components/settings/MobileNetworkInterfaceSection.tsx`
- Create: `src/renderer/src/components/settings/MobileNetworkInterfaceSection.test.tsx`

- [ ] **Step 1: Read `AgentCombobox.tsx` end-to-end**

  Read `src/renderer/src/components/agent/AgentCombobox.tsx` and `agent-combobox-command-state.ts` in full. You will be borrowing:
  - The `Popover` + `Command` + `CommandInput` + `CommandList` + `CommandItem` JSX structure.
  - The controlled `commandState`/`commandValue` pattern that mirrors `AgentCombobox`.
  - The `setInputNode`/`focusSearchInput` pattern for keyboard accessibility.

  Do not import agent-specific helpers (e.g. `searchAgentPickerEntries`, `agent-combobox-command-state` is shared but the search logic isn't needed here).

- [ ] **Step 2: Read the current `MobileNetworkInterfaceSection.tsx` in full**

  Read the file. Note the props contract:
  ```ts
  type MobileNetworkInterfaceSectionProps = {
    networkInterfaces: MobileNetworkInterface[]
    selectedAddress: string | undefined
    onSelectedAddressChange: (address: string) => void
    refreshingNetworkInterfaces: boolean
    onRefreshNetworkInterfaces: () => void
    loading: boolean
    hasQrCode: boolean
    onGenerateQr: () => void
  }
  ```
  The contract **must not change** — only the inner control does. `MobilePairingQrSection.tsx` consumes `selectedAddress` and is unaffected.

- [ ] **Step 3: Write the failing render tests**

  Create `src/renderer/src/components/settings/MobileNetworkInterfaceSection.test.tsx`:

  ```tsx
  import React from 'react'
  import { describe, it, expect, vi } from 'vitest'
  import { render, screen } from '@testing-library/react'
  import userEvent from '@testing-library/user-event'
  import { MobileNetworkInterfaceSection } from './MobileNetworkInterfaceSection'
  import type { MobileNetworkInterface } from './mobile-network-interface-selection'

  const LAN: MobileNetworkInterface = { name: 'en0', address: '192.168.1.24' }
  const TAILNET: MobileNetworkInterface = { name: 'tailscale0', address: '100.64.1.20' }

  function renderSection(overrides: Partial<React.ComponentProps<typeof MobileNetworkInterfaceSection>> = {}) {
    const onSelectedAddressChange = vi.fn()
    const onRefreshNetworkInterfaces = vi.fn()
    const onGenerateQr = vi.fn()
    const props: React.ComponentProps<typeof MobileNetworkInterfaceSection> = {
      networkInterfaces: [LAN, TAILNET],
      selectedAddress: TAILNET.address,
      onSelectedAddressChange,
      refreshingNetworkInterfaces: false,
      onRefreshNetworkInterfaces,
      loading: false,
      hasQrCode: false,
      onGenerateQr,
      ...overrides
    }
    const user = userEvent.setup()
    const utils = render(<MobileNetworkInterfaceSection {...props} />)
    return { ...utils, user, onSelectedAddressChange, onRefreshNetworkInterfaces, onGenerateQr }
  }

  describe('MobileNetworkInterfaceSection', () => {
    it('renders the trigger with the currently selected address', () => {
      renderSection()
      expect(screen.getByRole('combobox')).toHaveTextContent('100.64.1.20 (tailscale0)')
    })

    it('lets the user type a custom address and confirms via the Use row', async () => {
      const { user, onSelectedAddressChange } = renderSection()
      await user.click(screen.getByRole('combobox'))
      const input = screen.getByPlaceholderText(/search or type/i)
      await user.type(input, 'my-mac.tail-abcd.ts.net')
      await user.click(screen.getByRole('option', { name: /Use "my-mac\.tail-abcd\.ts\.net"/ }))
      expect(onSelectedAddressChange).toHaveBeenCalledWith('my-mac.tail-abcd.ts.net')
    })

    it('shows an inline error and no Use row when the query is invalid', async () => {
      const { user } = renderSection()
      await user.click(screen.getByRole('combobox'))
      await user.type(screen.getByPlaceholderText(/search or type/i), 'not an address')
      expect(screen.getByText(/Enter an IPv4 address or Tailscale MagicDNS hostname/i)).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /Use / })).not.toBeInTheDocument()
    })

    it('suppresses the Use row when the typed address matches an existing interface', async () => {
      const { user } = renderSection()
      await user.click(screen.getByRole('combobox'))
      await user.type(screen.getByPlaceholderText(/search or type/i), '192.168.1.24')
      expect(screen.getByRole('option', { name: '192.168.1.24 (en0)' })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /Use "192\.168\.1\.24"/ })).not.toBeInTheDocument()
    })

    it('renders the (custom) label on the trigger after a custom selection', () => {
      renderSection({ selectedAddress: 'my-mac.tail-abcd.ts.net' })
      expect(screen.getByRole('combobox')).toHaveTextContent('my-mac.tail-abcd.ts.net (custom)')
    })

    it('shows No interfaces found when the list is empty', () => {
      renderSection({ networkInterfaces: [], selectedAddress: undefined })
      expect(screen.getByRole('combobox')).toHaveTextContent(/no interfaces found/i)
    })
  })
  ```

- [ ] **Step 4: Run the test file to verify it fails**

  ```bash
  pnpm vitest run src/renderer/src/components/settings/MobileNetworkInterfaceSection.test.tsx
  ```
  Expected: failures on every assertion — the component still uses `Select`. This is the failing-test step.

- [ ] **Step 5: Rewrite the component**

  Replace the entire body of `MobileNetworkInterfaceSection.tsx` with:

  ```tsx
  import { useCallback, useMemo, useState } from 'react'
  import { ChevronDown, ExternalLink, Loader2, QrCode, RefreshCw, Wifi } from 'lucide-react'
  import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger
  } from '../ui/accordion'
  import { Button } from '../ui/button'
  import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator
  } from '../ui/command'
  import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
  import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
  import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'
  import { translate } from '@/i18n/i18n'
  import {
    buildComboboxEntries,
    type MobileNetworkInterface
  } from './mobile-network-interface-selection'

  const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'
  const TRIGGER_LABEL_CUSTOM = 'custom'
  const ERROR_MESSAGE = 'Enter an IPv4 address or Tailscale MagicDNS hostname'

  type MobileNetworkInterfaceSectionProps = {
    networkInterfaces: MobileNetworkInterface[]
    selectedAddress: string | undefined
    onSelectedAddressChange: (address: string) => void
    refreshingNetworkInterfaces: boolean
    onRefreshNetworkInterfaces: () => void
    loading: boolean
    hasQrCode: boolean
    onGenerateQr: () => void
  }

  function formatInterfaceLabel(iface: MobileNetworkInterface): string {
    return `${iface.address} (${iface.name})`
  }

  function isCustomLabel(name: string): boolean {
    return name === TRIGGER_LABEL_CUSTOM
  }

  export function MobileNetworkInterfaceSection({
    networkInterfaces,
    selectedAddress,
    onSelectedAddressChange,
    refreshingNetworkInterfaces,
    onRefreshNetworkInterfaces,
    loading,
    hasQrCode,
    onGenerateQr
  }: MobileNetworkInterfaceSectionProps): React.JSX.Element {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    // Why: session-scoped custom selection (see spec). Cleared automatically
    // when the settings pane unmounts because the state lives in this component.
    const [customAddress, setCustomAddress] = useState<string | null>(null)

    const selectedIface = useMemo<MobileNetworkInterface | null>(() => {
      if (!selectedAddress) return null
      const matched = networkInterfaces.find((iface) => iface.address === selectedAddress)
      if (matched) return matched
      if (selectedAddress === customAddress) {
        return { name: TRIGGER_LABEL_CUSTOM, address: selectedAddress }
      }
      return null
    }, [networkInterfaces, selectedAddress, customAddress])

    const triggerLabel = selectedIface
      ? formatInterfaceLabel(selectedIface)
      : translate(
          'auto.components.settings.MobileNetworkInterfaceSection.b2c384cfd6',
          'No interfaces found'
        )

    const entries = useMemo(
      () => buildComboboxEntries(networkInterfaces, query),
      [networkInterfaces, query]
    )

    const queryParse = useMemo(() => parseManualNetworkAddress(query), [query])
    const showInlineError = query.trim() !== '' && !queryParse.ok

    const handleSelectInterface = useCallback(
      (iface: MobileNetworkInterface) => {
        setCustomAddress(null)
        setQuery('')
        setOpen(false)
        onSelectedAddressChange(iface.address)
      },
      [onSelectedAddressChange]
    )

    const handleSelectUseQuery = useCallback(
      (address: string) => {
        setCustomAddress(address)
        setQuery('')
        setOpen(false)
        onSelectedAddressChange(address)
      },
      [onSelectedAddressChange]
    )

    return (
      <div className="rounded-lg border border-border/60 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Wifi className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">
            {translate(
              'auto.components.settings.MobileNetworkInterfaceSection.406a35121c',
              'Network Interface'
            )}
          </span>
        </div>
        <p className="text-muted-foreground mb-3 text-xs">
          {translate(
            'auto.components.settings.MobileNetworkInterfaceSection.d536b5e20d',
            'Choose which network address to advertise in the QR code. Use your LAN address for same-network pairing, or an overlay network address (Tailscale, ZeroTier) for cross-network access.'
          )}
        </p>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  role="combobox"
                  aria-expanded={open}
                  className="min-w-[220px] justify-between font-normal"
                >
                  <span className="truncate">{triggerLabel}</span>
                  <ChevronDown className="ml-2 size-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[320px] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    value={query}
                    onValueChange={setQuery}
                    placeholder={translate(
                      'auto.components.settings.MobileNetworkInterfaceSection.new-combobox-placeholder',
                      'Search or type an address…'
                    )}
                  />
                  <CommandList>
                    <CommandEmpty>
                      {showInlineError ? ERROR_MESSAGE : translate(
                        'auto.components.settings.MobileNetworkInterfaceSection.new-combobox-empty',
                        'No matching interfaces'
                      )}
                    </CommandEmpty>
                    {entries.map((entry, index) => {
                      if (entry.kind === 'interface') {
                        return (
                          <CommandItem
                            key={`iface-${entry.iface.name}-${entry.iface.address}`}
                            value={`${entry.iface.address} ${entry.iface.name}`}
                            onSelect={() => handleSelectInterface(entry.iface)}
                          >
                            {formatInterfaceLabel(entry.iface)}
                          </CommandItem>
                        )
                      }
                      const isFirstUseQuery = index > 0
                      return (
                        <div key={`use-${entry.address}`}>
                          {isFirstUseQuery ? <CommandSeparator /> : null}
                          <CommandItem
                            value={`__use__ ${entry.address}`}
                            onSelect={() => handleSelectUseQuery(entry.address)}
                          >
                            Use &quot;{entry.address}&quot;
                          </CommandItem>
                        </div>
                      )
                    })}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onRefreshNetworkInterfaces}
                  disabled={refreshingNetworkInterfaces}
                  aria-label={translate(
                    'auto.components.settings.MobileNetworkInterfaceSection.a9db5d771d',
                    'Refresh network interfaces'
                  )}
                  className="text-muted-foreground"
                >
                  <RefreshCw className={refreshingNetworkInterfaces ? 'animate-spin' : ''} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.a9db5d771d',
                  'Refresh network interfaces'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
          {showInlineError ? (
            <p className="text-xs text-statusRed" role="status">
              {ERROR_MESSAGE}
            </p>
          ) : null}
          <Button
            onClick={onGenerateQr}
            disabled={loading || !selectedAddress}
            size="sm"
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : hasQrCode ? (
              <RefreshCw className="size-3.5" />
            ) : (
              <QrCode className="size-3.5" />
            )}
            {hasQrCode
              ? translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.1e64659126',
                  'Regenerate'
                )
              : translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.c541f67790',
                  'Generate QR Code'
                )}
          </Button>
        </div>
        <Accordion type="single" collapsible className="mt-4 border-t border-border/60 pt-2">
          <AccordionItem value="remote-pairing-guide">
            <AccordionTrigger className="py-2 text-xs">
              {translate(
                'auto.components.settings.MobileNetworkInterfaceSection.39fad211d9',
                'Connect outside your Wi-Fi with a tailnet'
              )}
            </AccordionTrigger>
            <AccordionContent className="space-y-3 text-xs text-muted-foreground">
              <p>
                {translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.9fc5d203ff',
                  'Orca Mobile connects directly to this computer. To use it away from the same local network, put your computer and phone on the same private overlay network, then generate the QR code with that network address selected.'
                )}
              </p>
              <ol className="list-decimal space-y-1 pl-4">
                <li>
                  {translate(
                    'auto.components.settings.MobileNetworkInterfaceSection.51d29927eb',
                    'Install'
                  )}{' '}
                  <button
                    type="button"
                    onClick={() => void window.api.shell.openUrl(TAILSCALE_DOWNLOAD_URL)}
                    className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {translate(
                      'auto.components.settings.MobileNetworkInterfaceSection.1dc87a7fbc',
                      'Tailscale'
                    )}
                    <ExternalLink className="size-3" />
                  </button>{' '}
                  {translate(
                    'auto.components.settings.MobileNetworkInterfaceSection.668016be7a',
                    'on your computer and phone.'
                  )}
                </li>
                <li>
                  {translate(
                    'auto.components.settings.MobileNetworkInterfaceSection.1f7c26d36a',
                    'Sign in to the same tailnet on both devices.'
                  )}
                </li>
                <li>
                  {translate(
                    'auto.components.settings.MobileNetworkInterfaceSection.87985ba6f5',
                    'In this Network Interface menu, choose the Tailscale address, usually a 100.x.y.z IP.'
                  )}
                </li>
                <li>
                  {translate(
                    'auto.components.settings.MobileNetworkInterfaceSection.63d5e4ae1e',
                    'Regenerate the QR code and scan it from the Orca mobile app.'
                  )}
                </li>
              </ol>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    )
  }
  ```

  Notes for the implementer:
  - `Command shouldFilter={false}` because we already filter in `buildComboboxEntries`. Without this, cmdk's default fuzzy filter would re-filter the manually-injected `__use__` row out of view.
  - The `value` prop on each `CommandItem` keeps cmdk happy but does not affect our filtering; we own filtering.
  - `useMemo` is used for `selectedIface`, `entries`, and `queryParse` so re-renders triggered by parent prop changes don't churn the combobox state.
  - If `isCustomLabel` is unused after a lint pass (no caller in the final file), delete the helper — the spec lists it but the implementation inlines the check.

- [ ] **Step 6: Run the new test file**

  ```bash
  pnpm vitest run src/renderer/src/components/settings/MobileNetworkInterfaceSection.test.tsx
  ```
  Expected: all six tests pass.

  If any fail:
  - `toHaveTextContent` mismatches → check the trigger label format.
  - `getByRole('option', { name: /Use "…"/ })` not found → verify `Command shouldFilter={false}` is set.
  - Inline error not appearing → verify `showInlineError` is computed against `queryParse.ok`.

- [ ] **Step 7: Run the full test suite for the settings folder**

  ```bash
  pnpm vitest run src/renderer/src/components/settings/
  ```
  Expected: all green. Confirm nothing else broke (e.g. `MobilePairingQrSection.test.tsx` if it exists).

- [ ] **Step 8: Lint, typecheck, build**

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm build
  ```
  Expected: all green. If `pnpm lint` complains about an unused import (e.g. `isCustomLabel` or `CommandSeparator`), remove it and re-run.

- [ ] **Step 9: Commit**

  ```bash
  git add src/renderer/src/components/settings/MobileNetworkInterfaceSection.tsx \
          src/renderer/src/components/settings/MobileNetworkInterfaceSection.test.tsx
  git commit -m "feat(mobile-pairing): combobox with manual address entry"
  ```

---

## Task 4: End-to-end verification & PR prep

**Files:** none modified; verification only.

- [ ] **Step 1: Run the four CI checks locally**

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  ```
  Expected: all green. This is exactly what `.github/workflows/` runs.

- [ ] **Step 2: Manual smoke check**

  If Orca can be launched locally with the desktop build:
  1. Open Settings → Mobile.
  2. Click the Network Interface dropdown — confirm both interfaces list.
  3. Type a tailnet address — confirm the `Use "…"` row appears.
  4. Click `Use "…"` — confirm the trigger switches to `… (custom)`.
  5. Click Refresh — confirm the custom selection survives.
  6. Type an invalid string — confirm the inline error appears and no `Use …` row is shown.
  7. Type an address that already matches an interface (e.g. `192.168.1.24`) — confirm the `Use` row is hidden and selecting the interface row does NOT show `(custom)`.

  Skip any step that requires a running desktop build and note it in the PR description.

- [ ] **Step 3: Capture before/after screenshots**

  Save screenshots to a temp directory (NOT to the repo — `CONTRIBUTING.md` and `AGENTS.md` forbid committing PR evidence images). Use gstack browse if running the production binary:
  ```bash
  $HOME/.claude/skills/gstack/browse/dist/browse screenshot /tmp/orca-mobile-section-before.png --selector ...
  ```
  Attach the screenshots to the PR conversation (never use `gh-attach`).

- [ ] **Step 4: Push the branch and draft the PR**

  ```bash
  git push origin HEAD
  gh pr create \
    --title "feat(mobile-pairing): combobox with manual network address entry" \
    --body-file /tmp/pr-body.md
  ```

  The PR body should follow `pull_request_template.md`:
  - **Summary:** explain that the desktop Network Interface dropdown now accepts a manually-typed IPv4 or Tailscale MagicDNS hostname.
  - **Screenshots:** link to the conversation-attached screenshots.
  - **Testing:** check all four `pnpm` boxes; note that `pnpm test` includes the three new test files (`manual-address.test.ts`, `mobile-network-interface-selection.test.ts`, `MobileNetworkInterfaceSection.test.tsx`).
  - **AI Review Report:** confirm the review checked cross-platform (no platform-specific code; uses shadcn primitives + cmdk patterns already in the codebase), SSH/remote/local compatibility (no change to main-process IPC), agent/integration compatibility (no change), performance (UI re-render cost is bounded by `useMemo` over the interface list), UI quality (follows STYLEGUIDE.md; uses `text-statusRed` for the error), security (no new IPC; the address flows through the existing `selectedAddress` prop which `MobilePairingQrSection` already validated).
  - **Security Audit:** no new IPC, no new auth surface, no new dependency, no new env var. The parser rejects malformed input early so the QR endpoint never sees invalid data.
  - **Notes:** none — single platform-agnostic renderer change.
  - **X handle:** include the contributor's X handle per CONTRIBUTING.md so maintainers can shout out.

- [ ] **Step 5: Request review**

  ```bash
  gh pr edit --add-reviewer <maintainer-handle>
  ```
  Or comment `@<maintainer>` in the PR if reviewer auto-assignment isn't available.

---

## Definition of done

- All four `pnpm` checks pass locally.
- All new and existing tests pass.
- The component renders correctly in a smoke test (or smoke-test steps are documented as skipped in the PR).
- The PR is open with a body matching `pull_request_template.md`.
- The contributor's X handle is in the PR description.
