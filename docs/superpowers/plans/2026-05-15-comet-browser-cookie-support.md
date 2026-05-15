# Comet Browser Cookie Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add [Comet](https://comet.perplexity.ai/) (Perplexity's Chromium-based browser) as a supported source in Orca's "Import cookies from another browser" pipeline, alongside Chrome / Edge / Arc / Brave / Firefox / Safari.

**Architecture:** Comet is Chromium-based, so it reuses the existing `CHROMIUM_BROWSERS` registration pipeline in `src/main/browser/browser-cookie-import.ts`. The encryption layer (PBKDF2 + AES-128-CBC + macOS Keychain "Safe Storage") is already generic — we only need to register Comet's platform data paths, keychain service/account, and label. A new `'comet'` discriminator is added to the `BrowserSessionProfileSource['browserFamily']` union and to `BROWSER_FAMILY_LABELS` so telemetry and UI labels stay accurate.

**Tech Stack:** TypeScript, Electron (main process), Node.js (`node:crypto`, `node:sqlite`, `node:fs`), React renderer, Vitest.

**Background — files you will touch:**

- `src/main/browser/browser-cookie-import.ts` — the cookie import pipeline. `CHROMIUM_BROWSERS` is the registration array at line ~82. `detectInstalledBrowsers()` at line ~299 iterates that array, resolves platform paths via `browserRootPath()`, enumerates profiles from `Local State`, and confirms the Cookies DB exists. Decryption is handled by a shared keychain path further down (line ~713).
- `src/shared/types.ts` — `BrowserSessionProfileSource.browserFamily` union at line ~387.
- `src/shared/constants.ts` — `BROWSER_FAMILY_LABELS` lookup at line ~36 (consumed by `BrowserProfileRow.tsx`, `BrowserUsePane.tsx`, `BrowserToolbarMenu.tsx`).
- `src/renderer/src/components/settings/BrowserPane.tsx` — settings copy at line ~231 ("import cookies from Chrome, Edge, or other browsers").
- `src/main/browser/browser-session-registry.test.ts` — registry test that exercises `updateProfileSource` with a `browserFamily` value (line ~114).
- `src/main/runtime/rpc/methods/browser.test.ts` — RPC-level cookie import test (line ~51).

**Why a new `'comet'` discriminator (not `'chromium'`):**

The existing `'chromium'` slot in `CHROMIUM_BROWSERS` is currently used for Brave (line ~109, `label: 'Brave'`), which already conflicts with the `BROWSER_FAMILY_LABELS['chromium'] = 'Chromium'` mapping. Adding Comet under `'chromium'` would compound that ambiguity. A dedicated `'comet'` family keeps the label/telemetry pipeline clean and matches the precedent of `'arc'` and `'edge'`. Adjusting Brave's discriminator is **out of scope** for this plan.

**Comet data paths and keychain — VERIFICATION REQUIRED before coding:**

These values are based on Perplexity's Chromium fork conventions but **must be verified on a real Comet install** in Task 1 before being committed. The plan deliberately gates implementation on this verification step because guessing wrong here = silent decryption failure for users.

Expected (to verify):

| Platform | Data root | Keychain service | Keychain account |
|---|---|---|---|
| macOS | `~/Library/Application Support/Comet` | `Comet Safe Storage` | `Comet` |
| Windows | `%LOCALAPPDATA%\Perplexity\Comet\User Data` | n/a (DPAPI per Local State) | n/a |
| Linux | not shipped as of 2026-05-15 — leave `linuxRoot` undefined | — | — |

---

## Pre-flight: spec coverage

This plan implements every acceptance criterion from issue #1923:

- AC1 (Comet appears in browser picker) → Tasks 2, 3
- AC2 (profiles enumerate from `Local State`) → reuses `discoverProfiles()`; covered by Task 4
- AC3 (cookies decrypt on macOS / Windows / Linux) → Tasks 1 (verify), 3 (register), 6 (smoke test)
- AC4 (SSH use case still works) → no main-process startup changes; existing `cookies-import` IPC unchanged. Covered implicitly; called out in Task 6.
- AC5 (tests cover the new family) → Tasks 4, 5

---

## Task 1: Verify Comet paths and Safe Storage entry on a real install

**Files:** none modified — this task produces a verification artifact only.

**Why this is Task 1:** every later task depends on these exact strings. Hard-coding the wrong keychain service name causes a silent "no key found" path that surfaces as "0 cookies imported" with no clear error. Confirm first.

**Environment gate (added by CEO review outside voice):** the entire task requires a Mac with Comet installed and signed in. If you are running this plan without that, do the following:
1. Install Comet from https://comet.perplexity.ai/ and sign in (or hand the task to someone who has it).
2. If you cannot get a Comet install, you can still execute Task 2 (type union), Task 5 (registry test), Task 6 (label map) as pure scaffolding, but **stop before Task 3 and Task 4** — they need the verified strings. Mark a `[BLOCKED — awaiting Comet install]` checkbox at the top of the file before pausing.

- [ ] **Step 0: Confirm Comet is installed on this machine**

```bash
ls -d /Applications/Comet.app 2>/dev/null && echo "COMET_INSTALLED" || echo "COMET_MISSING"
ls -d ~/Library/Application\ Support/Comet 2>/dev/null && echo "COMET_DATA_PRESENT" || echo "COMET_DATA_MISSING"
```

Expected: both `COMET_INSTALLED` and `COMET_DATA_PRESENT`. If either is missing, follow the gate above.

- [ ] **Step 1: Locate Comet's macOS data directory**

Open a Terminal on a Mac that has Comet installed and signed in. Run:

```bash
ls -la ~/Library/Application\ Support/Perplexity/ 2>/dev/null
ls -la ~/Library/Application\ Support/Comet/ 2>/dev/null | head -30
```

Expected: a `Comet/` directory containing `Local State`, at least one profile directory (`Default`, `Profile 1`, ...), and inside each profile either `Network/Cookies` or `Cookies`.

Record the absolute path. If the directory is **not** `Comet`, write the actual path down — it will be used in Task 3.

- [ ] **Step 2: Confirm the Cookies SQLite file**

```bash
file ~/Library/Application\ Support/Comet/Default/Network/Cookies 2>/dev/null \
  || file ~/Library/Application\ Support/Comet/Default/Cookies 2>/dev/null
```

Expected output contains `SQLite 3.x database`.

If neither path exists, scan with:

```bash
find ~/Library/Application\ Support/Perplexity -name 'Cookies' -type f 2>/dev/null
```

Record which subpath holds the Cookies DB. Orca already tries both `Network/Cookies` and `Cookies` via `resolveCookiesPath()`, so as long as one matches the existing pattern, no code change is needed here.

- [ ] **Step 3: Find Comet's Safe Storage Keychain entry**

```bash
security find-generic-password -s "Comet Safe Storage" -g 2>&1 | head -5
```

Expected: a line `"acct"<blob>="Comet"` and a password blob. If `security` reports `The specified item could not be found`, try variants:

```bash
security find-generic-password -s "Perplexity Comet Safe Storage" -g 2>&1 | head -5
security find-generic-password -s "Comet Browser Safe Storage" -g 2>&1 | head -5
```

Record the **exact** `keychainService` (the `-s` argument that succeeds) and the `acct` value (`keychainAccount`).

- [ ] **Step 4: Read `Local State` to confirm profile.info_cache shape**

```bash
python3 -c "import json; d=json.load(open('$HOME/Library/Application Support/Comet/Local State')); print(list(d.get('profile',{}).get('info_cache',{}).keys())[:5])"
```

Expected: a list of profile directory names. This confirms Comet's `Local State` schema matches Chrome's, which `discoverProfiles()` already handles.

- [ ] **Step 4b: Verify Comet's app bundle exposes a readable version string for UA spoofing**

```bash
defaults read /Applications/Comet.app/Contents/Info CFBundleShortVersionString
```

Expected: a Chrome-shaped version number (e.g., `120.0.6099.71`). This string is what `getUserAgentForBrowser()` at `browser-cookie-import.ts:689` will read to construct a User-Agent matching the source Comet install. Without this, imported Google session cookies invalidate on first request (see Task 3 Step 1b).

If the key is named differently or the app bundle path is not `/Applications/Comet.app`, record the actual bundle path and plist key — Task 3 will use those.

- [ ] **Step 5: Record findings**

Update this plan file in place — replace the "Expected (to verify)" table values with the verified strings, and check the box below.

- [ ] **Step 6: Commit the verified plan**

```bash
git add docs/superpowers/plans/2026-05-15-comet-browser-cookie-support.md
git commit -m "docs: verify Comet data paths and keychain entry"
```

---

## Task 2: Add `'comet'` to the `browserFamily` type union

**Files:**
- Modify: `src/shared/types.ts:387`

- [ ] **Step 1: Write the failing typecheck**

Add the new discriminator. Open `src/shared/types.ts` and change the union on line 387:

```ts
export type BrowserSessionProfileSource = {
  browserFamily: 'chrome' | 'chromium' | 'arc' | 'edge' | 'firefox' | 'safari' | 'comet' | 'manual'
  profileName?: string
  importedAt: number
}
```

- [ ] **Step 2: Run typecheck to confirm no regressions**

Run: `npm run typecheck`
Expected: clean (no errors). The union is used in `Record<string, string>` lookups via `BROWSER_FAMILY_LABELS`, which is keyed loosely — adding a new literal does not require any consumer change to compile.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(browser): add 'comet' to BrowserSessionProfileSource family union"
```

---

## Task 3: Register Comet in `CHROMIUM_BROWSERS`

**Files:**
- Modify: `src/main/browser/browser-cookie-import.ts:82` (the `CHROMIUM_BROWSERS` array)

- [ ] **Step 1: Append the Comet entry**

Open `src/main/browser/browser-cookie-import.ts`. The `CHROMIUM_BROWSERS` array starts at line ~82 with four entries (Chrome, Edge, Arc, Brave-as-chromium). Add a fifth entry after Brave, using the values **verified in Task 1**. Example (substitute the verified strings):

```ts
const CHROMIUM_BROWSERS: ChromiumBrowserDef[] = [
  // ...existing chrome/edge/arc/chromium entries unchanged...
  {
    family: 'comet',
    label: 'Comet',
    keychainService: 'Comet Safe Storage',
    keychainAccount: 'Comet',
    macRoot: 'Comet',
    winRoot: 'Comet/User Data'
    // linuxRoot intentionally omitted — Comet does not ship a Linux build as of 2026-05-15
  }
]
```

**Important:** if Task 1 found different strings, use those instead. Do **not** use the placeholders above without verification.

- [ ] **Step 1b: Add Comet UA spoofing case (CRITICAL — surfaced by CEO review outside voice)**

Open the same file. Find `getUserAgentForBrowser()` at line ~689. The function maps `browserFamily` to a User-Agent string by reading the source browser's plist version. The comment at line 658 documents *why*: "Google and other services bind auth cookies to the User-Agent that created them. We read the source browser's real version from its plist and construct a matching UA string so imported sessions aren't invalidated."

Without a Comet case, the switch falls through to `default: return null` and the imported session uses Electron's default UA — Google detects the UA mismatch and invalidates the session cookie immediately.

Add a Comet case to the switch:

```ts
case 'comet': {
  // Why: Comet is Chromium-based and ships a Chrome-shaped version in its plist.
  // Use the same UA shape as Chrome itself so Google-bound auth cookies survive import.
  const v = readBrowserVersion('/Applications/Comet.app')
  return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
}
```

If Task 1 Step 4b found a different bundle path (not `/Applications/Comet.app`), use the verified path instead.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean. The new `family: 'comet'` literal is now valid because Task 2 extended the union, and the switch is now exhaustive over all chromium-family discriminators.

- [ ] **Step 3: Commit**

```bash
git add src/main/browser/browser-cookie-import.ts
git commit -m "feat(browser): register Comet in CHROMIUM_BROWSERS with UA spoofing"
```

---

## Task 4: Unit-test Comet detection

**Files:**
- Test: `src/main/browser/browser-cookie-import.test.ts` (create if absent, otherwise extend)

**Why four test cases (not one):** the happy path alone gives false confidence. CEO review pinned these three additional negative paths as load-bearing for rigor mode: (a) Comet absent → fail-closed, (b) multi-profile enumeration → prevents silent "only Default works" regression, (c) installed-but-never-opened → trialist users with no cookies DB don't break detection.

Check first whether this test file exists:

```bash
ls src/main/browser/browser-cookie-import.test.ts 2>/dev/null
```

If it does not exist, the test pattern below creates it. If it does, append the new `describe` block.

- [ ] **Step 1: Write the failing happy-path test for Comet detection**

This test mocks the filesystem so it runs cross-platform without a real Comet install. Use Vitest's `vi.mock` of `node:fs`. If the existing test file uses a different mocking approach (e.g., `mock-fs`), match that style — check `src/main/browser/browser-session-registry.test.ts:1-30` for the project's preferred mocking idiom.

Create or extend `src/main/browser/browser-cookie-import.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

describe('detectInstalledBrowsers — Comet', () => {
  const originalPlatform = process.platform
  const originalHome = process.env.HOME

  beforeEach(() => {
    // Why: browser-cookie-import.ts uses destructured named imports from 'node:fs'
    // which are bound at module-load time. Without vi.resetModules(), only the
    // first test's vi.doMock takes effect — subsequent tests see the cached module
    // with the first test's mock still applied. resetModules must run BEFORE each
    // doMock so the next import() picks up the fresh mock factory.
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.HOME = '/Users/test'
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env.HOME = originalHome
    vi.restoreAllMocks()
  })

  it('detects Comet when its data directory and Cookies DB exist', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes('Comet/Default/Network/Cookies')) return true
          if (p.includes('Comet/Local State')) return true
          return false
        },
        readFileSync: (p: string, enc?: string) => {
          if (typeof p === 'string' && p.includes('Comet/Local State')) {
            return JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } })
          }
          return actual.readFileSync(p as never, enc as never)
        }
      }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const detected = detectInstalledBrowsers()
    const comet = detected.find((b) => b.family === 'comet')
    expect(comet).toBeDefined()
    expect(comet?.label).toBe('Comet')
    expect(comet?.cookiesPath).toContain('Comet/Default/Network/Cookies')
    expect(comet?.keychainService).toBe('Comet Safe Storage')
  })
})
```

- [ ] **Step 2: Run the happy-path test**

Run: `npx vitest run src/main/browser/browser-cookie-import.test.ts -t "detects Comet when"`
Expected: PASS — Task 3 already registered the entry. If FAIL with `comet` undefined, recheck Task 3's `CHROMIUM_BROWSERS` literal and that the keychainService string in the test matches the verified string from Task 1.

- [ ] **Step 3: Add the negative test (Comet absent from filesystem)**

Append inside the same `describe` block:

```ts
it('does not list Comet when its data directory is absent', async () => {
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
      ...actual,
      existsSync: () => false
    }
  })

  const { detectInstalledBrowsers } = await import('./browser-cookie-import')
  const detected = detectInstalledBrowsers()
  expect(detected.find((b) => b.family === 'comet')).toBeUndefined()
})
```

Run: `npx vitest run src/main/browser/browser-cookie-import.test.ts -t "does not list Comet"`
Expected: PASS. If FAIL, Task 3's `CHROMIUM_BROWSERS` entry is forcing detection independent of filesystem state — bug in the registration logic.

- [ ] **Step 4: Add the multi-profile test**

Append inside the same `describe` block:

```ts
it('enumerates all Comet profiles from Local State info_cache', async () => {
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
      ...actual,
      existsSync: (p: string) => {
        if (p.includes('Comet/Default/Network/Cookies')) return true
        if (p.includes('Comet/Local State')) return true
        return false
      },
      readFileSync: (p: string, enc?: string) => {
        if (typeof p === 'string' && p.includes('Comet/Local State')) {
          return JSON.stringify({
            profile: {
              info_cache: {
                Default: { name: 'Personal' },
                'Profile 1': { name: 'Work' },
                'Profile 2': { name: 'Research' }
              }
            }
          })
        }
        return actual.readFileSync(p as never, enc as never)
      }
    }
  })

  const { detectInstalledBrowsers } = await import('./browser-cookie-import')
  const detected = detectInstalledBrowsers()
  const comet = detected.find((b) => b.family === 'comet')
  expect(comet).toBeDefined()
  const directories = comet!.profiles.map((p) => p.directory).sort()
  expect(directories).toEqual(['Default', 'Profile 1', 'Profile 2'])
  const names = comet!.profiles.map((p) => p.name).sort()
  expect(names).toEqual(['Personal', 'Research', 'Work'])
})
```

Run: `npx vitest run src/main/browser/browser-cookie-import.test.ts -t "enumerates all Comet profiles"`
Expected: PASS. If FAIL with only `Default` returned, `discoverProfiles()` in `browser-cookie-import.ts:162` is silently falling back — investigate the JSON parse path.

- [ ] **Step 5: Add the installed-but-unused test**

Append inside the same `describe` block:

```ts
it('skips Comet when the data directory exists but no Cookies DB is present', async () => {
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
      ...actual,
      existsSync: (p: string) => {
        // Local State exists (Comet was launched at least once)
        if (p.includes('Comet/Local State')) return true
        // But no profile has a Cookies DB (user never browsed or just downloaded)
        if (p.includes('Network/Cookies') || p.endsWith('/Cookies')) return false
        return false
      },
      readFileSync: (p: string, enc?: string) => {
        if (typeof p === 'string' && p.includes('Comet/Local State')) {
          return JSON.stringify({ profile: { info_cache: { Default: { name: 'Default' } } } })
        }
        return actual.readFileSync(p as never, enc as never)
      }
    }
  })

  const { detectInstalledBrowsers } = await import('./browser-cookie-import')
  const detected = detectInstalledBrowsers()
  expect(detected.find((b) => b.family === 'comet')).toBeUndefined()
})
```

Run: `npx vitest run src/main/browser/browser-cookie-import.test.ts -t "skips Comet when the data directory exists"`
Expected: PASS. If FAIL with Comet present, `detectInstalledBrowsers()` is not honoring the `if (cookiesPath)` skip — bug.

- [ ] **Step 6: Run the full Comet describe block to confirm no cross-test pollution**

Run: `npx vitest run src/main/browser/browser-cookie-import.test.ts`
Expected: 4 tests PASS. The `vi.resetModules()` call in `beforeEach` (added in Step 1) is what prevents cross-test pollution from the destructured `node:fs` imports — if you removed it and tests still passed individually but failed together, you'd find this exact issue. If tests fail with `existsSync is not a function` or similar, Vitest may be running under jsdom; confirm the test file's surroundings target the node environment (`/* @vitest-environment node */` at top of file, or vitest config sets it).

- [ ] **Step 7: Commit**

```bash
git add src/main/browser/browser-cookie-import.test.ts
git commit -m "test(browser): cover Comet detection happy path, absence, multi-profile, and unused cases"
```

---

## Task 4b: Unit-test the Comet UA spoofing case and the label lookup

**Files:**
- Modify: `src/main/browser/browser-cookie-import.test.ts` (append two `describe` blocks)

**Why this task exists (eng review):** `getUserAgentForBrowser()` currently has zero test coverage anywhere in the repo (grep returns no test references). The Comet case added in Task 3 Step 1b is the load-bearing fix that keeps Google sessions alive — Task 8's manual smoke is the only verification today. If the implementer skips Task 8 Step 4, the regression ships silently. Same logic for `BROWSER_FAMILY_LABELS['comet']` — a typo (`comat: 'Comet'`) passes typecheck because the table is `Record<string, string>`.

- [ ] **Step 1: Add the UA spoofing test for Comet**

Append at the bottom of `src/main/browser/browser-cookie-import.test.ts` (outside the existing Comet detection `describe` block):

```ts
describe('getUserAgentForBrowser — Comet', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.restoreAllMocks()
  })

  it('returns a Chrome-shaped UA string when Comet plist version reads successfully', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return {
        ...actual,
        execFileSync: (cmd: string, args: readonly string[]) => {
          if (cmd === 'defaults' && args[1]?.includes('/Applications/Comet.app/Contents/Info')) {
            return '120.0.6099.71\n'
          }
          return actual.execFileSync(cmd, args as never)
        }
      }
    })

    // Force darwin-only code path
    const mod = await import('./browser-cookie-import')
    // Why: getUserAgentForBrowser is module-private. Reach it via the public
    // import path: importCookiesFromBrowser calls it internally. To test directly,
    // export it from the module under test OR cover via importCookiesFromBrowser
    // with a mock. The simpler shape is to add `export` to getUserAgentForBrowser
    // in browser-cookie-import.ts itself — do that in Task 3 Step 1c before this
    // test runs (one-line change: `export function getUserAgentForBrowser(...)`).
    const ua = (mod as unknown as {
      getUserAgentForBrowser: (f: string) => string | null
    }).getUserAgentForBrowser('comet')

    expect(ua).not.toBeNull()
    expect(ua).toContain('Macintosh; Intel Mac OS X 10_15_7')
    expect(ua).toContain('AppleWebKit/537.36')
    expect(ua).toContain('Chrome/120.0.6099.71')
    expect(ua).toContain('Safari/537.36')
  })

  it('returns null when reading the Comet plist version throws', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return {
        ...actual,
        execFileSync: () => {
          throw new Error('defaults: domain not found')
        }
      }
    })

    const mod = await import('./browser-cookie-import')
    const ua = (mod as unknown as {
      getUserAgentForBrowser: (f: string) => string | null
    }).getUserAgentForBrowser('comet')

    expect(ua).toBeNull()
  })

  it('returns null on non-darwin platforms regardless of family', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const mod = await import('./browser-cookie-import')
    const ua = (mod as unknown as {
      getUserAgentForBrowser: (f: string) => string | null
    }).getUserAgentForBrowser('comet')

    expect(ua).toBeNull()
  })
})
```

**Important:** the test reaches `getUserAgentForBrowser` via a cast because the function is currently module-private. Before this test runs, add the `export` keyword in Task 3 Step 1c below.

- [ ] **Step 1c (back-edit Task 3): export `getUserAgentForBrowser`**

Open `src/main/browser/browser-cookie-import.ts`. Change line ~661 from:

```ts
function getUserAgentForBrowser(
```

to:

```ts
export function getUserAgentForBrowser(
```

This is the only API surface change to the file required by tests. No callers move; the function stays primarily used internally by `importCookiesFromBrowser`.

- [ ] **Step 2: Run the UA tests**

Run: `npx vitest run src/main/browser/browser-cookie-import.test.ts -t "getUserAgentForBrowser"`
Expected: 3 PASS. If FAIL with "module has no exported member getUserAgentForBrowser", Step 1c was skipped. If FAIL with mismatched UA shape, the Comet case in Task 3 Step 1b deviates from the Chrome UA template — check it against the existing `chrome` case at line ~691.

- [ ] **Step 3: Add the BROWSER_FAMILY_LABELS lookup test**

Append at the bottom of the same file:

```ts
import { BROWSER_FAMILY_LABELS } from '../../shared/constants'

describe('BROWSER_FAMILY_LABELS — Comet', () => {
  it('maps the comet family key to the user-facing label "Comet"', () => {
    expect(BROWSER_FAMILY_LABELS.comet).toBe('Comet')
  })
})
```

Why this lives here (not in `src/shared/constants.test.ts`): there is no existing constants test file, and adding one for a one-line assertion has worse signal-to-overhead than colocating with the other Comet tests. If a constants test file appears in the future, this test moves there.

- [ ] **Step 4: Run the label test**

Run: `npx vitest run src/main/browser/browser-cookie-import.test.ts -t "BROWSER_FAMILY_LABELS"`
Expected: PASS. If FAIL, Task 6's edit to `constants.ts` is missing or misspelled.

- [ ] **Step 5: Run the full test file to confirm 7 tests pass**

Run: `npx vitest run src/main/browser/browser-cookie-import.test.ts`
Expected: 7 tests pass (4 detection + 3 UA + 1 label, the label `describe` adds one test, the 3 UA `describe` adds three).

Count: 4 (detection) + 3 (UA) + 1 (label) = **8 tests**. Adjust the count expectation if you skip Step 3 of Task 4 or Step 1c of this task.

- [ ] **Step 6: Commit**

```bash
git add src/main/browser/browser-cookie-import.ts src/main/browser/browser-cookie-import.test.ts
git commit -m "test(browser): cover Comet UA spoofing and label lookup"
```

---

## Task 5: Test registry round-trip for `browserFamily: 'comet'`

**Files:**
- Modify: `src/main/browser/browser-session-registry.test.ts` (append a new `it` block after the existing `updates profile source` test at line ~114)

- [ ] **Step 1: Add the failing test**

Open `src/main/browser/browser-session-registry.test.ts` and add this test after line ~123 (the closing of the existing "updates profile source" test):

```ts
it('updates profile source with comet family', () => {
  const profile = browserSessionRegistry.createProfile('imported', 'Comet Source Test')
  expect(profile).not.toBeNull()
  const updated = browserSessionRegistry.updateProfileSource(profile!.id, {
    browserFamily: 'comet',
    importedAt: Date.now()
  })
  expect(updated).not.toBeNull()
  expect(updated!.source?.browserFamily).toBe('comet')
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/main/browser/browser-session-registry.test.ts`
Expected: PASS — the registry stores `browserFamily` as an opaque string and Task 2 already widened the type union.

- [ ] **Step 3: Commit**

```bash
git add src/main/browser/browser-session-registry.test.ts
git commit -m "test(browser): cover comet browserFamily in session registry"
```

---

## Task 6: Add Comet to `BROWSER_FAMILY_LABELS`

**Files:**
- Modify: `src/shared/constants.ts:36`

- [ ] **Step 1: Extend the lookup table**

Open `src/shared/constants.ts`. The `BROWSER_FAMILY_LABELS` constant starts at line 36. Add a `comet` entry:

```ts
export const BROWSER_FAMILY_LABELS: Record<string, string> = {
  chrome: 'Google Chrome',
  chromium: 'Chromium',
  arc: 'Arc',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  firefox: 'Firefox',
  safari: 'Safari',
  comet: 'Comet',
  manual: 'File'
}
```

- [ ] **Step 2: Verify renderer consumers compile**

Run: `npm run typecheck`
Expected: clean. The three consumers (`BrowserProfileRow.tsx:80`, `BrowserUsePane.tsx:167`, `BrowserToolbarMenu.tsx:178`) all access the table with `?? <fallback>`, so adding a new key is non-breaking.

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants.ts
git commit -m "feat(browser): add Comet label to BROWSER_FAMILY_LABELS"
```

---

## Task 7: Update settings copy to mention "and Comet"

**Files:**
- Modify: `src/renderer/src/components/settings/BrowserPane.tsx:231`

- [ ] **Step 1: Read the current description line**

Open `src/renderer/src/components/settings/BrowserPane.tsx` and locate line 231:

```tsx
description="Manage browser profiles and import cookies from Chrome, Edge, or other browsers."
```

- [ ] **Step 2: Edit the description**

Keep it short — the picker enumerates installed browsers anyway, so we just want the copy to no longer feel out-of-date. Change to:

```tsx
description="Manage browser profiles and import cookies from Chrome, Edge, Comet, or other browsers."
```

- [ ] **Step 3: Smoke-test the settings search index**

This page is search-gated. Verify the new word is searchable:

Run: `grep -nE "description.*cookies" src/renderer/src/components/settings/browser-search.ts || true`
Expected: if `browser-search.ts` indexes this description, the search entry array picks the new copy up automatically because settings search reads the description string at render time. If a separate search-keyword array exists, add `'comet'` to it.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/BrowserPane.tsx
git commit -m "feat(browser): mention Comet in cookie import settings copy"
```

---

## Task 8: Manual smoke test on a Comet install (macOS)

**Files:** none — verification only.

**Why a manual task:** the decryption path uses real macOS Keychain access via `security find-generic-password`, which cannot be unit-tested without leaking real credentials. A short manual smoke confirms the end-to-end flow.

- [ ] **Step 1: Build and launch Orca from this branch**

```bash
npm run dev
```

Expected: Orca window opens. No console errors mentioning `cookie-import`.

- [ ] **Step 2: Open Settings → Browser → Session & Cookies**

Click the **Import from another browser** button. Expected: Comet appears in the picker with the label "Comet".

- [ ] **Step 3: Rotate the diag log, then run an import**

The diag log accumulates across all browser imports — historical Chrome/Edge failures would trip the check below. Rotate first:

```bash
DIAG="$HOME/Library/Application Support/Orca/cookie-import-diag.log"
[ -f "$DIAG" ] && mv "$DIAG" "$DIAG.pre-comet-smoke.$(date +%s)"
```

(If the Orca app uses a different `app.getPath('userData')` directory — for example a dev build under `Orca (Dev)` — adjust the path. `ls ~/Library/Application\ Support/ | grep -i orca` lists candidates.)

Now pick Comet, pick a profile, run import.

Expected:
- The dialog reports `Imported N cookies from Comet`.
- N is greater than 0 (assuming the source Comet profile has cookies).
- The rotated-fresh `cookie-import-diag.log` contains no `decrypt failed` lines (the rotated `.pre-comet-smoke.*` file may still have old failures — ignore it).

- [ ] **Step 4: Verify cookies are usable — Google specifically**

Navigate the imported-profile tab to a Google service you were signed into in Comet (e.g., `https://mail.google.com` or `https://drive.google.com`).

Expected: still signed in, NOT redirected to login.

Why Google specifically: Google rejects auth cookies presented with a non-matching User-Agent. This is the precise failure mode the Comet UA case in Task 3 Step 1b is meant to prevent. A working GitHub or Reddit login is not sufficient evidence — they don't enforce UA binding. If Google logs you out, the Comet UA case in `getUserAgentForBrowser()` is wrong (likely the wrong plist key or app bundle path).

Also navigate to one non-Google site you were logged into (e.g. `https://github.com`) to confirm general cookie import works.

- [ ] **Step 5: SSH smoke check**

If you have an SSH remote configured, connect to it and repeat Step 2. The picker should still render (it relies on main-process detection running on the *local* side of the SSH bridge — detection is local-only, but the IPC surface must not regress).

Expected: picker renders, lists local browsers including Comet. Selecting Comet and importing imports into the *remote* profile, same as Chrome/Edge today.

- [ ] **Step 6: If all green, push the branch**

```bash
git push -u origin timothyjlaurent/Comet-browser-cookie-support
```

Then link this branch to issue #1923 via the PR description.

---

## Out of scope (deliberately deferred)

These are tempting to fold in but belong in separate issues:

- Brave's `family: 'chromium'` ambiguity (label says "Brave", but `BROWSER_FAMILY_LABELS['chromium']` says "Chromium"). Fixing this requires data migration of existing imported profiles.
- Comet on Linux. Perplexity does not ship a Linux build of Comet as of 2026-05-15. Re-evaluate when they do.
- Comet on Windows DPAPI decryption. Windows decryption uses a separate code path in `browser-cookie-import.ts` keyed on Local State `os_crypt.encrypted_key`, which is identical for all Chromium forks — no change expected, but defer Windows smoke-test until a Windows tester is available.
- Brave-equivalent rename of `family: 'chromium'` → `family: 'brave'`. Tracked separately.

---

## Self-review checklist (run before handing off)

- [ ] Every task has exact file paths and line numbers.
- [ ] No placeholders ("TBD", "implement later", "fill in details").
- [ ] Code blocks show full content, not "similar to Task N".
- [ ] Type names match across tasks: `browserFamily`, `'comet'`, `CHROMIUM_BROWSERS`, `BROWSER_FAMILY_LABELS`.
- [ ] Task 1 (verification) gates Task 3 (registration). Engineer cannot accidentally commit unverified path strings.
- [ ] Acceptance criteria from issue #1923 are all mapped to tasks in the pre-flight section.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open (mode: HOLD_SCOPE, 1 critical surfaced + folded into plan) | 1 critical gap (UA spoofing) → fixed in plan |
| Outside Voice | claude-subagent | Independent 2nd opinion | 1 | issues_found | 8 raised, 4 valid, 1 CRITICAL (UA), 3 process — all folded into plan |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 test gaps (UA unit test, label lookup) → Task 4b added |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | minimal UI scope (one-line copy change) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | N/A — internal feature, no public API |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — ready to implement. CEO + Outside Voice findings all folded into plan. Design and DX reviews not applicable to this scope.
