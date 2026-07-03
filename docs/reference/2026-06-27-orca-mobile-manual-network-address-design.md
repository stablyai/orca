# Design: Manual network address entry for Orca desktop mobile pairing

**Date:** 2026-06-27
**Scope:** Desktop renderer (Settings → Mobile → Network Interface section)
**Status:** Draft, awaiting user review

## Problem

`src/renderer/src/components/settings/MobileNetworkInterfaceSection.tsx` lets the user pick the network address that gets baked into the mobile-pairing QR code. Today the only options come from `networkInterfaces`, which is the list returned by the main process enumerating OS network interfaces (`en0`, `tailscale0`, etc.). If a user wants a tailnet address that the OS hasn't surfaced yet — a Tailscale MagicDNS hostname, a ZeroTier-assigned address not yet visible to the OS, or a manual LAN IP — they have no way to type one in. The QR ends up pointing at an interface the phone cannot actually reach.

## Decision summary

Replace the inner `Select` of `MobileNetworkInterfaceSection` with a `Popover + Command` ("combobox") pattern modeled on the existing `AgentCombobox`. The popover contains a single `CommandInput` that filters the auto-discovered interfaces above and renders a special "Use …" entry at the bottom of the list whenever the input is a valid IPv4 address or Tailscale MagicDNS hostname. Picking that entry selects a custom address; the trigger shows `<address> (custom)`. Custom addresses are session-scoped (cleared when the settings pane closes).

## Constraints (from `CONTRIBUTING.md` + `AGENTS.md`)

- Cross-platform: code paths must not assume a single platform; the manual entry path itself is platform-neutral.
- No `helpers`/`utils`/`misc` file names; use concrete names.
- No `eslint-disable max-lines`; split files instead.
- Prefer `.ts` over `.d.ts`.
- UI work follows `docs/STYLEGUIDE.md` and uses shadcn primitives from `src/renderer/src/components/ui/`.
- The renderer ↔ shared boundary is `src/shared/`; pure logic that may be reused outside the renderer goes there.
- Comments explain *why*, briefly.

## Files

| Path | Change |
| --- | --- |
| `src/shared/network/manual-address.ts` | **New.** Pure `parseManualNetworkAddress(input)` returning a discriminated union. |
| `src/shared/network/manual-address.test.ts` | **New.** Vitest cases for IPv4 and MagicDNS hostname validation. |
| `src/renderer/src/components/settings/mobile-network-interface-selection.ts` | Replace `mergeForSelect` with `buildComboboxEntries(interfaces, customAddress)` returning the entry list the UI maps over. |
| `src/renderer/src/components/settings/mobile-network-interface-selection.test.ts` | Replace `mergeForSelect` tests with `buildComboboxEntries` tests. |
| `src/renderer/src/components/settings/MobileNetworkInterfaceSection.tsx` | Swap `Select` for `Popover + Command`; add `open`/`query`/`customAddress` state. |
| `src/renderer/src/components/settings/MobileNetworkInterfaceSection.test.tsx` | **New.** Render tests via `@testing-library/react`. |

No changes to: `mobile/app/pair-scan.tsx`, `MobilePairingQrSection.tsx`, `use-mobile-install-qr.ts`, or any main-process code. The QR generation pipeline already consumes `selectedAddress: string`, which is all the new flow produces.

## Module 1: `parseManualNetworkAddress`

```ts
// src/shared/network/manual-address.ts
export type ParseManualAddressResult =
  | { ok: true; address: string }
  | { ok: false; error: string }

export function parseManualNetworkAddress(input: string): ParseManualAddressResult
```

**Rules** (in order):

1. `input.trim()` must be non-empty. Otherwise `{ ok: false, error: 'Enter an IPv4 address or Tailscale MagicDNS hostname' }`.
2. Reject any input containing whitespace anywhere; reject any input longer than 253 chars (DNS hostname cap).
3. Accept if it matches the IPv4 grammar (four dotted octets, each 0–255). No leading zeros except for `0` itself.
4. Accept if it matches the Tailscale MagicDNS hostname grammar:
   - Regex (case-insensitive): `/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net$/`
5. Otherwise return the same error as (1).

Pure function, no React, no I/O. Unit-testable in isolation.

## Module 2: `buildComboboxEntries`

```ts
// src/renderer/src/components/settings/mobile-network-interface-selection.ts
export type MobileNetworkInterface = { name: string; address: string }

export type ComboboxEntry =
  | { kind: 'interface'; iface: MobileNetworkInterface }
  | { kind: 'use-query'; address: string }   // only emitted when current query is valid

export function buildComboboxEntries(
  interfaces: readonly MobileNetworkInterface[],
  query: string
): readonly ComboboxEntry[]
```

**Behavior:**

- Trim `query`; if empty, return only `kind: 'interface'` entries from `interfaces` (no `use-query`).
- If `query` is non-empty, behavior branches on `parseManualNetworkAddress(query)`:
  - **Valid query:** skip substring filtering and keep every interface visible (so the user can pivot to an existing interface mid-typing). Emit each as `kind: 'interface'`.
  - **Invalid query:** filter `interfaces` by case-insensitive substring match on `iface.address` OR `iface.name`. Emit each as `kind: 'interface'`. If the filter yields zero matches, fall back to the full `interfaces` list (so the user always sees the available options, never an empty list mid-typing).
- After the interface entries, if the query parsed as valid AND no emitted interface has an `address` exactly equal to `parsed.address`, append `{ kind: 'use-query', address: parsed.address }`. (Suppression happens regardless of whether filtering ran, because valid queries skip filtering entirely — the check is against the visible interface list, which for valid queries is the full list.)
- Order: interface entries first (stable, in input order — either filtered or the full list per the branch above), then the optional `use-query`.
- The `selectRefreshedNetworkAddress` function is **kept** unchanged — it's still the rule that decides the *initial* `selectedAddress` when no manual entry exists. The UI calls it on mount and on Refresh; afterwards, the combobox owns the selection.

## Module 3: `MobileNetworkInterfaceSection` UI

Outer JSX (header text, description, Generate QR button, Refresh button, Tailnet accordion) is untouched. Only the inner selection control is replaced.

**State:**

```ts
const [open, setOpen] = useState(false)
const [query, setQuery] = useState('')
const [customAddress, setCustomAddress] = useState<string | null>(null)
```

`customAddress` is the last value the user confirmed via the `use-query` entry. It is the "session-scoped" custom selection that the trigger displays with the `(custom)` label. It is reset when the settings pane unmounts (React unmount handles this automatically; no global store involved).

**Trigger:** A `Button` styled like the existing `SelectTrigger` (`min-w-[220px]`, `size="sm"`). Label uses the same `formatInterfaceLabel` helper:

```ts
function formatInterfaceLabel(iface: { name: string; address: string }): string {
  return `${iface.address} (${iface.name})`
}
```

For the custom selection the rendered iface is `{ name: 'custom', address: customAddress }`, so the trigger shows `100.64.1.20 (custom)`.

**Popover body:** `Command` containing:

- `CommandInput` with placeholder `Search or type an address…` and `value={query}` / `onValueChange={setQuery}`.
- `CommandList` containing:
  - `CommandEmpty` shown only when no interfaces match AND `parseManualNetworkAddress(query)` is invalid (i.e., truly nothing to pick).
  - One `CommandItem` per `kind: 'interface'` entry from `buildComboboxEntries(networkInterfaces, query)`. `onSelect` calls `onSelectedAddressChange(iface.address)`, `setCustomAddress(null)`, `setQuery('')`, `setOpen(false)`.
  - Optional visual separator (e.g., `CommandSeparator`) before the `use-query` entry.
  - One `CommandItem` for `kind: 'use-query'` (only present when query is valid). Label: `Use "<query>"`. `onSelect` calls `onSelectedAddressChange(address)`, `setCustomAddress(address)`, `setQuery('')`, `setOpen(false)`.

**Controlled cmdk selection:** Copy the controlled-`commandValue` pattern from `src/renderer/src/components/agent/AgentCombobox.tsx` (imports `createAgentComboboxCommandState`, `resolveAgentComboboxCommandState`, `updateAgentComboboxCommandValue` from `@/components/agent/agent-combobox-command-state`, plus the `Command`, `CommandEmpty`, `CommandInput`, `CommandItem`, `CommandList` primitives from `@/components/ui/command`) so that hovering the footer doesn't leave a stale highlight on a list item. The exact state shape will be minimal — only one list, no footer-group complexity — so the borrowed helpers are sufficient. No new helpers are introduced in this design.

**Validation feedback:**

- When `query` is non-empty and invalid, render a one-line `text-xs text-statusRed` message directly below the trigger: `"Enter an IPv4 address or Tailscale MagicDNS hostname"`. Use the existing `statusRed` token from the theme to stay style-guide compliant.
- The `use-query` entry only appears when valid; no need to disable it.

**Refresh button:** Unchanged. Calls `onRefreshNetworkInterfaces`. The combobox re-renders with the new `networkInterfaces`; `query` and `customAddress` are preserved (user might be mid-typing).

**Generate QR button:** Unchanged. Disabled when `!selectedAddress`. No new branches.

## Data flow

```
networkInterfaces (prop, refreshed by parent)
        │
        ▼
buildComboboxEntries(networkInterfaces, query)
        │
        ▼
CommandList rows
        │
        ▼ onSelect
onSelectedAddressChange(string)  ─► parent re-renders MobilePairingQrSection
                                  ─► QR is regenerated with new endpoint
```

The parent of `MobileNetworkInterfaceSection` (whichever Settings tab owns it) already maintains `selectedAddress` and re-passes it down. This design does not change that contract.

## Edge cases

1. **Duplicate manual entry vs. existing interface** — `buildComboboxEntries` suppresses the `use-query` entry whenever the parsed query exactly equals an emitted interface's `address`. For valid queries the visible list is the full interface list (no substring filter runs), so the suppression check is against every interface, not just filtered ones. The user lands on the existing interface row instead of a duplicate.
2. **OS discovers the manual address later** — If `customAddress === '100.64.1.20'` and a refresh surfaces `100.64.1.20 (tailscale0)`, both are valid options; the user's selection stays. A future iteration may add a "merge" action; out of scope here.
3. **Empty `networkInterfaces`** — All-interface list is empty. If `query` is also empty, `CommandEmpty` shows. If `query` is valid, the `use-query` entry still appears so the user can type an address even when nothing is enumerated. The trigger shows `No interfaces found`.
4. **Manual address becomes unreachable at pair time** — Not handled here. The QR generation succeeds; `pair-scan.tsx` already surfaces "Cannot connect — same network?" on failure.
5. **Closing the popover with an invalid query typed** — `customAddress` and `selectedAddress` are unchanged. Next open starts with an empty `query`.

## Testing

**`src/shared/network/manual-address.test.ts`**

- Accepts: `0.0.0.0`, `255.255.255.255`, `192.168.1.24`, `100.64.1.20`.
- Rejects: `''`, `'   '`, `'1.2.3'`, `'1.2.3.4.5'`, `'256.0.0.1'`, `'01.02.03.04'` (leading zeros), `'192.168.1.24 '` (trailing space).
- Accepts MagicDNS: `my-mac.ts.net`, `my-mac.tail-abcd.ts.net`, `a.b.c.d.ts.net`.
- Rejects MagicDNS: `my-mac` (no `.ts.net`), `my-mac.ts.com`, `-foo.ts.net`, `MY-MAC.TS.NET` is accepted (case-insensitive).
- Rejects anything > 253 chars; rejects whitespace anywhere.
- Pure unit tests; no React, no mocks.

**`mobile-network-interface-selection.test.ts`**

- `buildComboboxEntries([LAN, TAILNET], '')` returns two interface entries, no `use-query`.
- `buildComboboxEntries([LAN, TAILNET], '100')` (invalid query) returns the tailnet interface only — substring filter on `100.64.1.20` matches `100` — and no `use-query` because the query did not parse.
- `buildComboboxEntries([LAN, TAILNET], '100.64.1.20')` (valid query) returns both interface entries (valid queries skip substring filtering) AND suppresses `use-query` because the parsed address equals an existing interface's `address`.
- `buildComboboxEntries([LAN, TAILNET], 'my-mac.tail-abcd.ts.net')` (valid query) returns both interface entries (valid queries skip substring filtering) plus a `use-query` with the trimmed address.
- `buildComboboxEntries([], '1.2.3.4')` returns just `use-query`.

**`MobileNetworkInterfaceSection.test.tsx`** (new)

- Open popover, type `100.64.1.20`, click `Use "100.64.1.20"` → trigger label becomes `100.64.1.20 (custom)`, query clears.
- Type `not-an-address` → error message renders, no `Use …` row.
- Type `192.168.1.24` (matches `en0`) → no `Use …` row; clicking the existing interface selects it as `en0`, not `custom`.
- Trigger label `No interfaces found` shown when `networkInterfaces` is empty and no manual selection.

## Out of scope

- Persistent storage of manual addresses across sessions (user explicitly chose session-scoped).
- IPv6, port suffixes, non-Tailscale hostnames (rejected by the parser).
- Mobile-side endpoint override (separate flow; see `mobile/app/pair-scan.tsx`).
- Main-process changes — the renderer has enough information already.

## Open questions for reviewer

1. Should the error message stay in English-only here, or get the same `translate('auto.…', 'fallback')` wrap as the rest of the section? Recommend: wrap it for consistency, since the rest of the component already uses `translate()`.
2. Should `customAddress` survive a "Refresh" click? Recommend yes — user might be mid-typing during a VPN reconnect. Confirmed in Edge case 5 above.
3. Should `CommandInput` accept paste of a multi-line string (e.g. user pastes `orca://pair?code=…`)? Recommend: no special handling; the existing trim+validate treats it as an invalid address and shows the error. Pair-URL paste remains the path through `pair-scan.tsx`.
