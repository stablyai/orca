# Per-Worktree Isolated Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/reference/2026-07-07-worktree-services-design.md`

**Goal:** Let a worktree opt in, at creation, to isolated per-worktree services (DB, cache, …) declared as `services:` recipes in `orca.yaml`, with unique slot/port allocation, env injection into every PTY, and automatic destroy on worktree removal.

**Architecture:** A new `services:` section in `orca.yaml` (parsed in `src/shared/orca-yaml.ts`) declares `create`/`destroy` shell commands per service. The main process owns provisioning: a dedicated JSON store (`orca-worktree-services.json`, mirroring `ephemeral-vm-runtime-store`) records `{worktreeId, slot, slug, env, status}`; provisioning runs inside the `worktrees:create` IPC handler after the git worktree exists and before setup terminals spawn; destroy runs inside `worktrees:remove`; orphan cleanup runs at app startup. The renderer holds a `worktreeId → env` map (hydrated over IPC) and merges it into the `env` payload of every PTY spawn for that worktree.

**Tech Stack:** Electron main/preload/renderer, TypeScript, Zod (store schema), Vitest, React + zustand (renderer), existing hook-runner machinery (`src/main/hooks.ts`).

## Global Constraints

- Cross-platform: macOS/Linux/Windows. Never hardcode `/`; use `path.join`. Shell selection follows `getHookShell()` in `src/main/hooks.ts` (`cmd.exe` on win32, `/bin/bash` elsewhere). WSL worktrees route commands through `wsl.exe` like `runHook` does.
- **v1 scope: local + WSL worktrees.** Remote (SSH, `repo.connectionId`) worktrees do not show the opt-in; Task 11 wires the remote path via the `runRemoteArchiveHook` pattern and may be deferred — everything else must keep `repo.connectionId` guards so remote is additive.
- No `max-lines` disables, no baseline additions (`pnpm check:max-lines-ratchet`). New files stay focused and small.
- No vague file names (`helpers`, `utils`). Names used here are final: `worktree-service-env.ts`, `worktree-services-store.ts`, `worktree-services.ts` (schema), `src/main/worktree-services.ts` (lifecycle), `src/main/ipc/worktree-services.ts` (IPC).
- Comments: only non-obvious "why", 1–2 lines.
- UI follows `docs/STYLEGUIDE.md`; badge/checkbox snippets below copy existing patterns verbatim-adjacent.
- Env var contract (from spec, exact names): `ORCA_WORKTREE_SLUG`, `ORCA_SERVICE_SLOT`, `ORCA_PORT_0` … `ORCA_PORT_9` where `ORCA_PORT_i = 20000 + slot*10 + i`.
- Service command timeout: `600_000` ms (10 min), NOT the 2-min `HOOK_TIMEOUT`.
- Test runner: Vitest. Run a single file with `pnpm vitest run <path>`.

---

### Task 1: `services:` parsing in orca.yaml + shared types

**Files:**
- Modify: `src/shared/types.ts` (append near `OrcaVmRecipe`, ~line 1979)
- Modify: `src/shared/orca-yaml.ts`
- Modify: `src/main/hooks.ts:68-73` (`RECOGNIZED_ORCA_YAML_KEYS`)
- Test: `src/main/hooks.test.ts` (existing `describe('parseOrcaYaml', …)` at line 43)

**Interfaces:**
- Produces: `OrcaServiceRecipe = { id: string; name: string; create: string; destroy?: string; env?: Record<string, string> }`; `OrcaHooks.services?: OrcaServiceRecipe[]`; `OrcaHooks.serviceDiagnostics?: OrcaVmRecipeDiagnostic[]` (reuses the existing `{index, field?, message}` diagnostic type). `parseOrcaYaml` returns them.

- [ ] **Step 1: Write failing tests**

Append to `describe('parseOrcaYaml', …)` in `src/main/hooks.test.ts`:

```ts
it('parses services recipes', () => {
  const yaml = [
    'services:',
    '  - id: db',
    '    name: Postgres 16',
    '    create: docker compose up -d --wait',
    '    destroy: docker compose down -v',
    '    env:',
    '      DATABASE_URL: postgres://app:app@localhost:${ORCA_PORT_0}/app'
  ].join('\n')
  expect(parseOrcaYaml(yaml)).toEqual({
    scripts: {},
    services: [
      {
        id: 'db',
        name: 'Postgres 16',
        create: 'docker compose up -d --wait',
        destroy: 'docker compose down -v',
        env: { DATABASE_URL: 'postgres://app:app@localhost:${ORCA_PORT_0}/app' }
      }
    ]
  })
})

it('reports diagnostics for invalid services entries', () => {
  const yaml = [
    'services:',
    '  - id: db',
    '    name: A',
    '    create: echo a',
    '  - id: db',
    '    name: B',
    '    create: echo b',
    '  - id: "BAD ID"',
    '    name: C',
    '    create: echo c',
    '  - id: nocreate',
    '    name: D'
  ].join('\n')
  const result = parseOrcaYaml(yaml)
  expect(result?.services).toEqual([{ id: 'db', name: 'A', create: 'echo a' }])
  expect(result?.serviceDiagnostics).toHaveLength(3)
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm vitest run src/main/hooks.test.ts -t services`
Expected: FAIL (`services` undefined in parse result).

- [ ] **Step 3: Add types**

In `src/shared/types.ts`, directly after `OrcaVmRecipeDiagnostic` (~line 1985):

```ts
export type OrcaServiceRecipe = {
  id: string
  name: string
  create: string
  destroy?: string
  env?: Record<string, string>
}
```

Extend `OrcaHooks` (lines 1953–1962) with two optional fields, keeping existing comment style:

```ts
  services?: OrcaServiceRecipe[] // Per-worktree isolated service recipes
  serviceDiagnostics?: OrcaVmRecipeDiagnostic[] // Non-fatal validation issues from services
```

- [ ] **Step 4: Implement `normalizeServices` in `src/shared/orca-yaml.ts`**

Add after `normalizeVmRecipes` (reuse `asRecord`, `asTrimmedString`, `ORCA_VM_RECIPE_ID_PATTERN`, `ORCA_VM_RECIPE_ID_RULE`):

```ts
type ServiceParseResult = {
  services: OrcaServiceRecipe[]
  diagnostics: OrcaVmRecipeDiagnostic[]
}

function normalizeServiceEnv(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) {
    return undefined
  }
  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      env[key] = String(raw)
    }
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function normalizeServices(value: unknown): ServiceParseResult {
  const diagnostics: OrcaVmRecipeDiagnostic[] = []
  if (!Array.isArray(value)) {
    return { services: [], diagnostics }
  }
  const seenIds = new Set<string>()
  const services = value
    .map((entry, index) => {
      const record = asRecord(entry)
      if (!record) {
        diagnostics.push({ index, message: 'Service entry must be a mapping.' })
        return null
      }
      const id = asTrimmedString(record.id)
      const name = asTrimmedString(record.name)
      const create = asTrimmedString(record.create)
      if (!id) {
        diagnostics.push({ index, field: 'id', message: 'Service id is required.' })
        return null
      }
      if (!ORCA_VM_RECIPE_ID_PATTERN.test(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Invalid service id "${id}". ${ORCA_VM_RECIPE_ID_RULE}`
        })
        return null
      }
      if (seenIds.has(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Duplicate service id "${id}". Service ids must be unique.`
        })
        return null
      }
      if (!name) {
        diagnostics.push({ index, field: 'name', message: `Service "${id}" is missing name.` })
        return null
      }
      if (!create) {
        diagnostics.push({ index, field: 'create', message: `Service "${id}" is missing create.` })
        return null
      }
      seenIds.add(id)
      const destroy = asTrimmedString(record.destroy)
      const env = normalizeServiceEnv(record.env)
      return {
        id,
        name,
        create,
        ...(destroy ? { destroy } : {}),
        ...(env ? { env } : {})
      }
    })
    .filter((entry): entry is OrcaServiceRecipe => entry !== null)
  return { services, diagnostics }
}
```

In `parseOrcaYaml`: parse `record.services` through `normalizeServices`, include `services`/`serviceDiagnostics` in the emptiness check (lines 150–159) and in the returned object (161–170), same conditional-spread style as `environmentRecipes`. Import `OrcaServiceRecipe` in the type import block.

- [ ] **Step 5: Recognize the key**

In `src/main/hooks.ts:68-73` add `'services'` to `RECOGNIZED_ORCA_YAML_KEYS`.

- [ ] **Step 6: Run tests, verify pass**

Run: `pnpm vitest run src/main/hooks.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/orca-yaml.ts src/main/hooks.ts src/main/hooks.test.ts
git commit -m "feat(services): parse per-worktree services recipes from orca.yaml"
```

---

### Task 2: Service env context — slug, ports, substitution

**Files:**
- Create: `src/shared/worktree-service-env.ts`
- Test: `src/shared/worktree-service-env.test.ts`

**Interfaces:**
- Produces:
  - `deriveServiceSlug(worktreeName: string, slot: number): string` — lowercased `[a-z0-9-]` slug, max 40 chars, always suffixed `-s<slot>` (uniqueness among live slots).
  - `buildServiceContextEnv(slug: string, slot: number): Record<string, string>` — `ORCA_WORKTREE_SLUG`, `ORCA_SERVICE_SLOT`, `ORCA_PORT_0..9` (`String(20000 + slot * 10 + i)`).
  - `resolveServiceEnv(template: Record<string, string> | undefined, contextEnv: Record<string, string>): Record<string, string>` — replaces `${KEY}` for every key of `contextEnv`, plain string replacement, no shell.

- [ ] **Step 1: Write failing tests**

`src/shared/worktree-service-env.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildServiceContextEnv,
  deriveServiceSlug,
  resolveServiceEnv
} from './worktree-service-env'

describe('deriveServiceSlug', () => {
  it('sanitizes and suffixes the slot', () => {
    expect(deriveServiceSlug('Fix Migrations!', 3)).toBe('fix-migrations-s3')
  })
  it('truncates long names but keeps the slot suffix', () => {
    const slug = deriveServiceSlug('x'.repeat(100), 12)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-s12')).toBe(true)
  })
  it('falls back when the name has no usable characters', () => {
    expect(deriveServiceSlug('***', 0)).toBe('worktree-s0')
  })
})

describe('buildServiceContextEnv', () => {
  it('exposes slug, slot, and ten deterministic ports', () => {
    const env = buildServiceContextEnv('demo-s2', 2)
    expect(env.ORCA_WORKTREE_SLUG).toBe('demo-s2')
    expect(env.ORCA_SERVICE_SLOT).toBe('2')
    expect(env.ORCA_PORT_0).toBe('20020')
    expect(env.ORCA_PORT_9).toBe('20029')
  })
})

describe('resolveServiceEnv', () => {
  it('substitutes context variables, plain string replacement', () => {
    const context = buildServiceContextEnv('demo-s0', 0)
    expect(
      resolveServiceEnv({ DATABASE_URL: 'postgres://localhost:${ORCA_PORT_0}/app' }, context)
    ).toEqual({ DATABASE_URL: 'postgres://localhost:20000/app' })
  })
  it('leaves unknown placeholders untouched and handles undefined template', () => {
    const context = buildServiceContextEnv('demo-s0', 0)
    expect(resolveServiceEnv({ A: '${NOT_A_VAR}' }, context)).toEqual({ A: '${NOT_A_VAR}' })
    expect(resolveServiceEnv(undefined, context)).toEqual({})
  })
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm vitest run src/shared/worktree-service-env.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/shared/worktree-service-env.ts`:

```ts
export const SERVICE_PORT_BASE = 20000
export const SERVICE_PORTS_PER_SLOT = 10

export function deriveServiceSlug(worktreeName: string, slot: number): string {
  const suffix = `-s${slot}`
  const base =
    worktreeName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40 - suffix.length)
      .replace(/-+$/g, '') || 'worktree'
  return `${base}${suffix}`
}

export function buildServiceContextEnv(slug: string, slot: number): Record<string, string> {
  const env: Record<string, string> = {
    ORCA_WORKTREE_SLUG: slug,
    ORCA_SERVICE_SLOT: String(slot)
  }
  for (let i = 0; i < SERVICE_PORTS_PER_SLOT; i++) {
    env[`ORCA_PORT_${i}`] = String(SERVICE_PORT_BASE + slot * SERVICE_PORTS_PER_SLOT + i)
  }
  return env
}

export function resolveServiceEnv(
  template: Record<string, string> | undefined,
  contextEnv: Record<string, string>
): Record<string, string> {
  if (!template) {
    return {}
  }
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(template)) {
    resolved[key] = value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) =>
      name in contextEnv ? contextEnv[name] : match
    )
  }
  return resolved
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm vitest run src/shared/worktree-service-env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/worktree-service-env.ts src/shared/worktree-service-env.test.ts
git commit -m "feat(services): slug, deterministic port block, and env substitution"
```

---

### Task 3: Worktree services store (persistence + slot allocation)

**Files:**
- Create: `src/shared/worktree-services.ts` (Zod schema + types)
- Create: `src/shared/worktree-services-store.ts`
- Test: `src/shared/worktree-services-store.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 4–8):

```ts
export type WorktreeServicesStatus = 'provisioning' | 'ready' | 'create_failed' | 'destroy_failed'
export type WorktreeServicesRecord = {
  worktreeId: string
  repoId: string
  slot: number
  slug: string
  serviceIds: string[]
  env: Record<string, string> // resolved env, includes ORCA_WORKTREE_SLUG/ORCA_SERVICE_SLOT/ORCA_PORT_*
  status: WorktreeServicesStatus
  error?: string
  createdAt: string
  updatedAt: string
}
// worktree-services-store.ts
export function getWorktreeServicesStorePath(userDataPath: string): string
export function listWorktreeServicesRecords(userDataPath: string): WorktreeServicesRecord[]
export function getWorktreeServicesRecord(userDataPath: string, worktreeId: string): WorktreeServicesRecord | null
export function allocateServiceSlot(userDataPath: string): number // smallest int >= 0 not used by any record
export function upsertWorktreeServicesRecord(userDataPath: string, record: WorktreeServicesRecord): WorktreeServicesRecord
export function removeWorktreeServicesRecord(userDataPath: string, worktreeId: string): WorktreeServicesRecord | null
```

- [ ] **Step 1: Write failing tests**

`src/shared/worktree-services-store.test.ts` — use a temp dir per test (`fs.mkdtempSync(join(os.tmpdir(), 'orca-svc-'))`), mirroring how `ephemeral-vm-runtime-store` is tested if a test exists (check `src/shared/ephemeral-vm-runtime-store.test.ts` and copy its temp-dir setup verbatim if present):

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  allocateServiceSlot,
  getWorktreeServicesRecord,
  listWorktreeServicesRecords,
  removeWorktreeServicesRecord,
  upsertWorktreeServicesRecord
} from './worktree-services-store'
import type { WorktreeServicesRecord } from './worktree-services'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-svc-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(worktreeId: string, slot: number): WorktreeServicesRecord {
  return {
    worktreeId,
    repoId: 'repo-1',
    slot,
    slug: `wt-s${slot}`,
    serviceIds: ['db'],
    env: { ORCA_SERVICE_SLOT: String(slot) },
    status: 'ready',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z'
  }
}

describe('worktree services store', () => {
  it('starts empty and allocates slot 0', () => {
    expect(listWorktreeServicesRecords(dir)).toEqual([])
    expect(allocateServiceSlot(dir)).toBe(0)
  })

  it('round-trips records and fills slot gaps', () => {
    upsertWorktreeServicesRecord(dir, record('wt-a', 0))
    upsertWorktreeServicesRecord(dir, record('wt-b', 2))
    expect(allocateServiceSlot(dir)).toBe(1)
    expect(getWorktreeServicesRecord(dir, 'wt-a')?.slot).toBe(0)
  })

  it('remove frees the slot and returns the removed record', () => {
    upsertWorktreeServicesRecord(dir, record('wt-a', 0))
    expect(removeWorktreeServicesRecord(dir, 'wt-a')?.worktreeId).toBe('wt-a')
    expect(allocateServiceSlot(dir)).toBe(0)
    expect(removeWorktreeServicesRecord(dir, 'wt-a')).toBeNull()
  })

  it('upsert replaces the record for the same worktreeId', () => {
    upsertWorktreeServicesRecord(dir, record('wt-a', 0))
    upsertWorktreeServicesRecord(dir, { ...record('wt-a', 0), status: 'create_failed' })
    expect(listWorktreeServicesRecords(dir)).toHaveLength(1)
    expect(getWorktreeServicesRecord(dir, 'wt-a')?.status).toBe('create_failed')
  })
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm vitest run src/shared/worktree-services-store.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement schema**

`src/shared/worktree-services.ts` — mirror `src/shared/ephemeral-vm-runtimes.ts` style (read it first):

```ts
import { z } from 'zod'

export const WorktreeServicesStatusSchema = z.enum([
  'provisioning',
  'ready',
  'create_failed',
  'destroy_failed'
])
export type WorktreeServicesStatus = z.infer<typeof WorktreeServicesStatusSchema>

export const WorktreeServicesRecordSchema = z.object({
  worktreeId: z.string().min(1),
  repoId: z.string().min(1),
  slot: z.number().int().nonnegative(),
  slug: z.string().min(1),
  serviceIds: z.array(z.string().min(1)),
  env: z.record(z.string(), z.string()),
  status: WorktreeServicesStatusSchema,
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type WorktreeServicesRecord = z.infer<typeof WorktreeServicesRecordSchema>

export const WorktreeServicesStoreSchema = z.object({
  version: z.literal(1),
  records: z.array(WorktreeServicesRecordSchema)
})
export type WorktreeServicesStore = z.infer<typeof WorktreeServicesStoreSchema>
```

- [ ] **Step 4: Implement store**

`src/shared/worktree-services-store.ts` — copy the read/write skeleton of `src/shared/ephemeral-vm-runtime-store.ts` (its private `read…`/`write…` pair uses `writeSecureJsonFile`/`hardenExistingSecureFile` from `./secure-file`; keep identical usage):

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from './secure-file'
import {
  WorktreeServicesStoreSchema,
  type WorktreeServicesRecord,
  type WorktreeServicesStore
} from './worktree-services'

const WORKTREE_SERVICES_FILE = 'orca-worktree-services.json'

export function getWorktreeServicesStorePath(userDataPath: string): string {
  return join(userDataPath, WORKTREE_SERVICES_FILE)
}

function readStore(userDataPath: string): WorktreeServicesStore {
  const path = getWorktreeServicesStorePath(userDataPath)
  if (!existsSync(path)) {
    return { version: 1, records: [] }
  }
  hardenExistingSecureFile(path)
  try {
    return WorktreeServicesStoreSchema.parse(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return { version: 1, records: [] }
  }
}

function writeStore(userDataPath: string, store: WorktreeServicesStore): void {
  writeSecureJsonFile(getWorktreeServicesStorePath(userDataPath), store)
}

export function listWorktreeServicesRecords(userDataPath: string): WorktreeServicesRecord[] {
  return readStore(userDataPath).records
}

export function getWorktreeServicesRecord(
  userDataPath: string,
  worktreeId: string
): WorktreeServicesRecord | null {
  return readStore(userDataPath).records.find((r) => r.worktreeId === worktreeId) ?? null
}

export function allocateServiceSlot(userDataPath: string): number {
  const used = new Set(readStore(userDataPath).records.map((r) => r.slot))
  let slot = 0
  while (used.has(slot)) {
    slot++
  }
  return slot
}

export function upsertWorktreeServicesRecord(
  userDataPath: string,
  record: WorktreeServicesRecord
): WorktreeServicesRecord {
  const store = readStore(userDataPath)
  const records = store.records.filter((r) => r.worktreeId !== record.worktreeId)
  records.push(record)
  writeStore(userDataPath, { version: 1, records })
  return record
}

export function removeWorktreeServicesRecord(
  userDataPath: string,
  worktreeId: string
): WorktreeServicesRecord | null {
  const store = readStore(userDataPath)
  const removed = store.records.find((r) => r.worktreeId === worktreeId) ?? null
  if (removed) {
    writeStore(userDataPath, {
      version: 1,
      records: store.records.filter((r) => r.worktreeId !== worktreeId)
    })
  }
  return removed
}
```

If `writeSecureJsonFile`/`hardenExistingSecureFile` signatures differ from this usage, match whatever `ephemeral-vm-runtime-store.ts` does — that file is the source of truth for the pattern.

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run src/shared/worktree-services-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/worktree-services.ts src/shared/worktree-services-store.ts src/shared/worktree-services-store.test.ts
git commit -m "feat(services): per-worktree services store with slot allocation"
```

---

### Task 4: Main lifecycle — run commands, provision, destroy

**Files:**
- Create: `src/main/worktree-services.ts`
- Test: `src/main/worktree-services.test.ts`

**Interfaces:**
- Consumes: Task 1 `OrcaServiceRecipe`, Task 2 env functions, Task 3 store functions.
- Produces:

```ts
export type ServiceProvisionEvent = {
  provisionId: string
  serviceId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}
export type ProvisionWorktreeServicesArgs = {
  userDataPath: string
  worktreeId: string
  worktreeName: string
  worktreePath: string
  repo: Repo
  services: OrcaServiceRecipe[]
  provisionId?: string
  onEvent?: (event: ServiceProvisionEvent) => void
}
export function provisionWorktreeServices(args: ProvisionWorktreeServicesArgs): Promise<WorktreeServicesRecord>
export function destroyWorktreeServices(args: {
  userDataPath: string
  worktreeId: string
  worktreePath: string
  repo: Repo
  services: OrcaServiceRecipe[]
}): Promise<{ success: boolean; errors: string[] }>
export const SERVICE_COMMAND_TIMEOUT_MS = 600_000
```

Behavior contract:
- `provisionWorktreeServices`: `allocateServiceSlot` → `deriveServiceSlug(worktreeName, slot)` → `buildServiceContextEnv` → upsert record `status: 'provisioning'` → run each service's `create` **sequentially** (stop at first failure) with `env: { ...process.env, ...contextEnv, ORCA_WORKTREE_PATH: worktreePath }`, `cwd: worktreePath`, shell `/bin/bash` (`cmd.exe` on win32 — same choice as `getHookShell()` in hooks.ts), timeout `SERVICE_COMMAND_TIMEOUT_MS` — on success, merge every recipe's `resolveServiceEnv(recipe.env, contextEnv)` plus `contextEnv` into `record.env`, set `status: 'ready'`; on failure set `status: 'create_failed'`, `error`, keep the record (slot stays reserved so retry reuses it), then **best-effort destroy already-created services** in reverse order.
- `destroyWorktreeServices`: look up record (no record → `{success: true, errors: []}`); run `destroy` for each provisioned service (recipes without `destroy` are skipped), collecting failures instead of throwing; remove record (freeing the slot) **even when some destroys fail** — the spec makes removal non-blocking; return errors for the caller to log/toast.
- WSL: when `isWslPath(worktreePath)` (import from `src/main/wsl.ts`), run through `execFile('wsl.exe', …)` exactly like the WSL branch of `runHook` (`src/main/hooks.ts:565+`) — copy that escaping (`replace(/'/g, "'\\''")`) and env-translation approach.

- [ ] **Step 1: Write failing tests**

`src/main/worktree-services.test.ts` — mock `node:child_process.exec` with `vi.mock`; use a temp userData dir like Task 3. Test cases:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, exec: execMock }
})

import { destroyWorktreeServices, provisionWorktreeServices } from './worktree-services'
import { getWorktreeServicesRecord } from '../shared/worktree-services-store'
import type { OrcaServiceRecipe, Repo } from '../shared/types'

const repo = { id: 'repo-1', path: '/tmp/repo' } as Repo
const services: OrcaServiceRecipe[] = [
  {
    id: 'db',
    name: 'Postgres',
    create: 'echo create-db',
    destroy: 'echo destroy-db',
    env: { DATABASE_URL: 'pg://localhost:${ORCA_PORT_0}/app' }
  }
]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-svc-main-'))
  execMock.mockReset()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function execSucceeds(): void {
  execMock.mockImplementation((_cmd, _opts, cb) => {
    cb(null, 'ok', '')
    return { kill: vi.fn() }
  })
}

describe('provisionWorktreeServices', () => {
  it('allocates slot 0, resolves env, persists a ready record', async () => {
    execSucceeds()
    const record = await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'My Task',
      worktreePath: '/tmp/repo-worktrees/my-task',
      repo,
      services
    })
    expect(record.status).toBe('ready')
    expect(record.slot).toBe(0)
    expect(record.env.DATABASE_URL).toBe('pg://localhost:20000/app')
    expect(record.env.ORCA_WORKTREE_SLUG).toBe('my-task-s0')
    expect(getWorktreeServicesRecord(dir, 'wt-1')?.status).toBe('ready')
  })

  it('marks create_failed and keeps the record on command failure', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) => {
      cb(new Error('boom'), '', 'docker: not found')
      return { kill: vi.fn() }
    })
    const record = await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    expect(record.status).toBe('create_failed')
    expect(record.error).toContain('db')
    expect(getWorktreeServicesRecord(dir, 'wt-1')?.status).toBe('create_failed')
  })
})

describe('destroyWorktreeServices', () => {
  it('runs destroy, removes the record, frees the slot', async () => {
    execSucceeds()
    await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    const result = await destroyWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    expect(result).toEqual({ success: true, errors: [] })
    expect(getWorktreeServicesRecord(dir, 'wt-1')).toBeNull()
  })

  it('still removes the record when destroy fails, reporting the error', async () => {
    execSucceeds()
    await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    execMock.mockImplementation((_cmd, _opts, cb) => {
      cb(new Error('gone'), '', '')
      return { kill: vi.fn() }
    })
    const result = await destroyWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    expect(result.success).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(getWorktreeServicesRecord(dir, 'wt-1')).toBeNull()
  })

  it('is a no-op without a record', async () => {
    const result = await destroyWorktreeServices({
      userDataPath: dir,
      worktreeId: 'nope',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    expect(result).toEqual({ success: true, errors: [] })
    expect(execMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm vitest run src/main/worktree-services.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/main/worktree-services.ts`**

Core shape (WSL branch: copy the escaping/exec pattern from `runHook`'s WSL branch in `src/main/hooks.ts` when `isWslPath(worktreePath)`):

```ts
import { exec } from 'node:child_process'
import {
  buildServiceContextEnv,
  deriveServiceSlug,
  resolveServiceEnv
} from '../shared/worktree-service-env'
import {
  allocateServiceSlot,
  getWorktreeServicesRecord,
  removeWorktreeServicesRecord,
  upsertWorktreeServicesRecord
} from '../shared/worktree-services-store'
import type { OrcaServiceRecipe, Repo } from '../shared/types'
import type { WorktreeServicesRecord } from '../shared/worktree-services'

export const SERVICE_COMMAND_TIMEOUT_MS = 600_000

function getServiceShell(): string {
  return process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/bash'
}

function runServiceCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd,
        shell: getServiceShell(),
        timeout: SERVICE_COMMAND_TIMEOUT_MS,
        env: { ...process.env, ...env }
      },
      (error, stdout, stderr) => {
        resolve({
          success: !error,
          output: [stdout, stderr, error ? String(error.message) : '']
            .filter(Boolean)
            .join('\n')
        })
      }
    )
    child.stdout?.on('data', (chunk: string) => onChunk?.('stdout', String(chunk)))
    child.stderr?.on('data', (chunk: string) => onChunk?.('stderr', String(chunk)))
  })
}
```

`provisionWorktreeServices` / `destroyWorktreeServices` follow the behavior contract above; timestamps via `new Date().toISOString()`. Emit `onEvent` per chunk with the current `serviceId`. On create failure, best-effort destroy of already-created services in reverse order (ignore their errors), record keeps `slot`/`slug` so a retry reuses them (`getWorktreeServicesRecord` first: if an existing `create_failed` record exists, reuse its slot/slug instead of reallocating).

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm vitest run src/main/worktree-services.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/worktree-services.ts src/main/worktree-services.test.ts
git commit -m "feat(services): main-process provision/destroy lifecycle"
```

---

### Task 5: IPC handlers + preload API

**Files:**
- Create: `src/main/ipc/worktree-services.ts`
- Modify: `src/main/window/attach-main-window-services.ts` (register next to `registerWorktreeHandlers`, line 85)
- Modify: `src/preload/api-types.ts` (new `worktreeServices` block, near `ephemeralVm` at ~line 2064)
- Modify: `src/preload/index.ts` (new block near `ephemeralVm` at ~line 2472)
- Test: `src/main/ipc/worktree-services.test.ts`

**Interfaces:**
- Produces preload API `window.api.worktreeServices`:

```ts
worktreeServices: {
  list: () => Promise<WorktreeServicesRecord[]>
  retry: (args: { worktreeId: string }) => Promise<WorktreeServicesRecord>
  onProvisionEvent: (cb: (event: ServiceProvisionEvent) => void) => () => void
}
```

- [ ] **Step 1: Write failing test**

`src/main/ipc/worktree-services.test.ts`: mock `electron` (`ipcMain.handle` capture pattern — copy the mock setup from `src/main/ipc/ephemeral-vm.test.ts`, which already exists and mocks `electron`/`app.getPath`). Assert that `registerWorktreeServicesHandlers(store)` registers `worktreeServices:list` and `worktreeServices:retry`, and that `worktreeServices:list` returns the records from a seeded temp store.

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm vitest run src/main/ipc/worktree-services.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement handlers**

`src/main/ipc/worktree-services.ts` — follow `src/main/ipc/ephemeral-vm-runtime-handlers.ts:42` pattern (`ipcMain.removeHandler` then `ipcMain.handle`):

```ts
ipcMain.handle('worktreeServices:list', (): WorktreeServicesRecord[] =>
  listWorktreeServicesRecords(app.getPath('userData'))
)

ipcMain.handle(
  'worktreeServices:retry',
  async (event, args: { worktreeId: string }): Promise<WorktreeServicesRecord> => {
    // resolve worktree + repo from the persistence store, reload hooks, re-run provisioning
    // with onEvent → event.sender.send('worktreeServices:provisionEvent', e)
  }
)
```

`retry` resolves the worktree/repo the same way `worktrees:remove` does in `src/main/ipc/worktrees.ts:1345+` (read that handler's worktree lookup and reuse the same store accessors), loads `loadHooks(repo.path)?.services ?? []`, and calls `provisionWorktreeServices` (existing `create_failed` record's slot/slug are reused per Task 4). Register from `attach-main-window-services.ts:85` next to `registerWorktreeHandlers`.

- [ ] **Step 4: Preload plumbing**

`src/preload/api-types.ts`: add the `worktreeServices` block to `PreloadApi` (types above; import `WorktreeServicesRecord` from `src/shared/worktree-services`, `ServiceProvisionEvent` from a type-only import). `src/preload/index.ts` (copy the `ephemeralVm` block shape at 2472–2492 including the `onProvisionEvent` listener add/remove pattern at 2478–2484):

```ts
worktreeServices: {
  list: () => ipcRenderer.invoke('worktreeServices:list'),
  retry: (args) => ipcRenderer.invoke('worktreeServices:retry', args),
  onProvisionEvent: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, event: ServiceProvisionEvent): void =>
      callback(event)
    ipcRenderer.on('worktreeServices:provisionEvent', listener)
    return () => ipcRenderer.removeListener('worktreeServices:provisionEvent', listener)
  }
} satisfies PreloadApi['worktreeServices'],
```

- [ ] **Step 5: Run tests + typecheck, verify pass**

Run: `pnpm vitest run src/main/ipc/worktree-services.test.ts` then `pnpm typecheck` (or the repo's typecheck script from package.json).
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/worktree-services.ts src/main/window/attach-main-window-services.ts src/preload/api-types.ts src/preload/index.ts src/main/ipc/worktree-services.test.ts
git commit -m "feat(services): worktreeServices IPC surface and preload API"
```

---

### Task 6: Provision during `worktrees:create`, env into setup script

**Files:**
- Modify: `src/shared/types.ts` — `CreateWorktreeArgs` (~line 2067): add `provisionServices?: boolean` and `serviceProvisionId?: string`
- Modify: `src/main/ipc/worktree-remote.ts` — `createLocalWorktree` (line 1944), around the setup-launch block at 2529–2578
- Test: extend `src/main/worktree-services.test.ts` only if new pure logic is extracted; the wiring itself is covered by Task 12's e2e-style check

**Interfaces:**
- Consumes: Task 4 `provisionWorktreeServices`, Task 1 `loadHooks(...).services`.
- Produces: worktree created with `provisionServices: true` has a `ready` (or `create_failed`) store record before setup terminals spawn; `setup.envVars` includes the resolved service env.

- [ ] **Step 1: Implement wiring in `createLocalWorktree`**

After the worktree exists and `createdEffectiveHooks` is loaded (before the `setupScript` block at 2529), insert:

```ts
let serviceEnv: Record<string, string> = {}
const serviceRecipes = createdEffectiveHooks?.services ?? []
if (args.provisionServices && serviceRecipes.length > 0) {
  try {
    const record = await provisionWorktreeServices({
      userDataPath: app.getPath('userData'),
      worktreeId: worktree.id,
      worktreeName: args.name,
      worktreePath,
      repo,
      services: serviceRecipes,
      provisionId: args.serviceProvisionId,
      onEvent: (event) => mainWindow.webContents.send('worktreeServices:provisionEvent', event)
    })
    if (record.status === 'ready') {
      serviceEnv = record.env
    }
  } catch (error) {
    console.error(`[services] provisioning failed for ${worktreePath}:`, error)
  }
}
```

(Adapt local identifiers — `worktree.id`, `worktreePath`, `mainWindow` — to the actual names in scope in that function; read the surrounding 50 lines first. A `create_failed` record must NOT abort worktree creation — spec: worktree kept, retry available.)

Then merge into the setup launch: where `setup = createSetupRunnerScript(...)` is assigned (~2570), follow with:

```ts
if (setup && Object.keys(serviceEnv).length > 0) {
  setup = { ...setup, envVars: { ...setup.envVars, ...serviceEnv } }
}
```

- [ ] **Step 2: Typecheck + existing tests**

Run: `pnpm typecheck && pnpm vitest run src/main/worktree-create-timing.test.ts src/main/hooks.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts src/main/ipc/worktree-remote.ts
git commit -m "feat(services): provision isolated services during worktree creation"
```

---

### Task 7: Destroy on `worktrees:remove` + startup orphan cleanup

**Files:**
- Modify: `src/main/ipc/worktrees.ts` — inside the `worktrees:remove` handler, next to the archive-hook block at 1587–1605
- Create: `src/main/worktree-services-orphan-cleanup.ts`
- Modify: `src/main/index.ts` — call orphan cleanup after app ready / store load (find where other startup maintenance runs; `hydrate-local-pty-registry` callers are a good anchor)
- Test: `src/main/worktree-services-orphan-cleanup.test.ts`

**Interfaces:**
- Consumes: Task 4 `destroyWorktreeServices`, Task 3 store.
- Produces: `cleanupOrphanedWorktreeServices(args: { userDataPath: string; existingWorktreeIds: Set<string>; resolveRepo: (repoId: string) => Repo | null }): Promise<void>`

- [ ] **Step 1: Write failing tests for orphan cleanup**

`src/main/worktree-services-orphan-cleanup.test.ts` — same `exec` mock + temp dir as Task 4:

- Seed two records (`wt-live`, `wt-gone`); `existingWorktreeIds = new Set(['wt-live'])`; `resolveRepo` returns the repo for both. Assert: after cleanup, `wt-gone`'s record is removed (destroy ran — `execMock` called) and `wt-live`'s record is untouched.
- `resolveRepo` returns `null` for the orphan's repo → record removed without exec (recipes unavailable; freeing the slot beats leaking it forever).

- [ ] **Step 2: Run tests, verify failure**

Run: `pnpm vitest run src/main/worktree-services-orphan-cleanup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { loadHooks } from './hooks'
import { destroyWorktreeServices } from './worktree-services'
import {
  listWorktreeServicesRecords,
  removeWorktreeServicesRecord
} from '../shared/worktree-services-store'
import type { Repo } from '../shared/types'

export async function cleanupOrphanedWorktreeServices(args: {
  userDataPath: string
  existingWorktreeIds: Set<string>
  resolveRepo: (repoId: string) => Repo | null
}): Promise<void> {
  for (const record of listWorktreeServicesRecords(args.userDataPath)) {
    if (args.existingWorktreeIds.has(record.worktreeId)) {
      continue
    }
    const repo = args.resolveRepo(record.repoId)
    const services = repo ? (loadHooks(repo.path)?.services ?? []) : []
    if (repo && services.length > 0) {
      await destroyWorktreeServices({
        userDataPath: args.userDataPath,
        worktreeId: record.worktreeId,
        worktreePath: repo.path,
        repo,
        services
      })
    } else {
      removeWorktreeServicesRecord(args.userDataPath, record.worktreeId)
    }
  }
}
```

(Note `worktreePath: repo.path` — the worktree directory is gone; destroy commands must be runnable from the repo root, which holds the compose file. This matches the spec's recipe contract: `destroy` references the project name/slug, not worktree files.)

- [ ] **Step 4: Wire destroy into `worktrees:remove`**

In `src/main/ipc/worktrees.ts`, immediately after the archive-hook block (1587–1605), local repos only (`!repo.connectionId`):

```ts
const serviceRecipes = !repo.connectionId ? (loadHooks(repo.path)?.services ?? []) : []
const servicesRecord = getWorktreeServicesRecord(app.getPath('userData'), args.worktreeId)
if (servicesRecord) {
  const destroyResult = await destroyWorktreeServices({
    userDataPath: app.getPath('userData'),
    worktreeId: args.worktreeId,
    worktreePath: canonicalWorktreePath,
    repo,
    services: serviceRecipes
  })
  if (!destroyResult.success) {
    console.error(
      `[services] destroy failed for ${canonicalWorktreePath}:`,
      destroyResult.errors.join('; ')
    )
  }
}
```

Failure must never block removal (already guaranteed: `destroyWorktreeServices` never throws).

Wire startup cleanup in `src/main/index.ts` after the persistence store is available: build `existingWorktreeIds` from the store's worktrees, `resolveRepo` from the store's repos, run `void cleanupOrphanedWorktreeServices(...)` without awaiting app readiness on it.

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run src/main/worktree-services-orphan-cleanup.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/worktree-services-orphan-cleanup.ts src/main/worktree-services-orphan-cleanup.test.ts src/main/ipc/worktrees.ts src/main/index.ts
git commit -m "feat(services): destroy services on worktree removal and clean orphans at startup"
```

---

### Task 8: Renderer — services state slice + PTY env injection

**Files:**
- Create: `src/renderer/src/lib/worktree-service-env-injection.ts`
- Modify: `src/renderer/src/store/slices/worktrees.ts` — add `worktreeServicesEnv: Record<string, Record<string, string>>` state + `hydrateWorktreeServices()` action
- Modify: `src/renderer/src/components/terminal-pane/pty-connection.ts:2637-2652` (identity-env block)
- Modify: `src/renderer/src/lib/launch-agent-background-session.ts:141-147`
- Modify: `src/renderer/src/lib/launch-worktree-background-terminals.ts:56-58`
- Test: `src/renderer/src/lib/worktree-service-env-injection.test.ts`

**Interfaces:**
- Produces: `getWorktreeServiceEnv(worktreeId: string | undefined): Record<string, string>` — reads the zustand store, returns `{}` when absent.
- Consumes: `window.api.worktreeServices.list()` (Task 5).

- [ ] **Step 1: Write failing test**

`worktree-service-env-injection.test.ts` — follow the store-mocking style of `src/renderer/src/lib/launch-worktree-background-terminals.test.ts` (read it first; it already mocks `@/store`). Cases: env returned for a known worktreeId; `{}` for unknown id and for `undefined`.

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm vitest run src/renderer/src/lib/worktree-service-env-injection.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { useAppStore } from '@/store'

export function getWorktreeServiceEnv(
  worktreeId: string | undefined
): Record<string, string> {
  if (!worktreeId) {
    return {}
  }
  return useAppStore.getState().worktreeServicesEnv[worktreeId] ?? {}
}
```

Store slice (`worktrees.ts`): add `worktreeServicesEnv: {}` initial state and

```ts
hydrateWorktreeServices: async () => {
  const records = await window.api.worktreeServices.list()
  const worktreeServicesEnv: Record<string, Record<string, string>> = {}
  for (const record of records) {
    if (record.status === 'ready') {
      worktreeServicesEnv[record.worktreeId] = record.env
    }
  }
  set({ worktreeServicesEnv })
}
```

Call `hydrateWorktreeServices()` where other startup hydration runs (find the caller that hydrates worktrees at app boot in the same slice) and after any provision/retry completes (Tasks 9–10 call it).

- [ ] **Step 4: Inject at the three PTY env call sites**

Each site merges service env BELOW identity env (identity keys must win). `pty-connection.ts:2645-2651`:

```ts
const paneEnv = {
  ...paneStartup?.env,
  ...getWorktreeServiceEnv(deps.worktreeId),
  ...paneIdentityEnv
}
```

Same one-line spread insertion in `launch-agent-background-session.ts` (before the ORCA_* identity keys, over `startupPlan.env`) and `launch-worktree-background-terminals.ts`.

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run src/renderer/src/lib/worktree-service-env-injection.test.ts src/renderer/src/lib/launch-worktree-background-terminals.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/worktree-service-env-injection.ts src/renderer/src/lib/worktree-service-env-injection.test.ts src/renderer/src/store/slices/worktrees.ts src/renderer/src/components/terminal-pane/pty-connection.ts src/renderer/src/lib/launch-agent-background-session.ts src/renderer/src/lib/launch-worktree-background-terminals.ts
git commit -m "feat(services): inject per-worktree service env into terminals and agents"
```

---

### Task 9: Composer opt-in checkbox + creation-flow plumbing

**Files:**
- Modify: `src/renderer/src/lib/pending-worktree-creation.ts` — `WorktreeCreationPhase` (line 19): add `'provisioning-services'`; `WorktreeCreationRequest` (~line 30): add `provisionServices?: boolean`; `getCreationProgressLabel` (line 123): map `'provisioning-services'` → `'Provisioning services…'`
- Modify: `src/renderer/src/hooks/useComposerState.ts` — checkbox state + request field (request literal at ~4109)
- Modify: `src/renderer/src/components/NewWorkspaceComposerCard.tsx` — checkbox UI (pattern at 987–1034)
- Modify: `src/renderer/src/store/slices/worktrees.ts` — `createWorktree` (~2793): thread `provisionServices` + `serviceProvisionId` into `createArgs` (built at 2848–2883)
- Modify: `src/renderer/src/lib/worktree-creation-flow.ts` — subscribe to provision events around the `createWorktree` call (~140–168)

**Interfaces:**
- Consumes: `window.api.worktreeServices.onProvisionEvent` (Task 5), `CreateWorktreeArgs.provisionServices`/`serviceProvisionId` (Task 6).
- Produces: user-visible opt-in; streamed provisioning log on the pending-creation card.

- [ ] **Step 1: Detect service recipes for the selected repo**

In `useComposerState.ts`, the repo's hooks are already consulted for ephemeral recipes (fields at 4091–4107). Expose `repoHasServiceRecipes: boolean` the same way those recipe lists reach the composer (follow `ephemeralVmRecipe` plumbing backwards to find where repo hooks land in renderer state; reuse that source). Gate: local repos only (`!repo.connectionId`).

- [ ] **Step 2: Checkbox UI**

In `NewWorkspaceComposerCard.tsx`, copy the "Reuse branch" control block (987–1034) verbatim-adjacent: same collapsible grid wrapper keyed on `repoHasServiceRecipes`, same sr-only checkbox + emerald check box, label `translate('auto.components.NewWorkspaceComposerCard.provisionIsolatedServices', 'Isolated services')`, hint `translate('auto.components.NewWorkspaceComposerCard.provisionIsolatedServicesHint', 'Provision this workspace\'s own services (database, cache) from orca.yaml.')`. State `provisionServices` defaults to `false`, lives in `useComposerState` next to the reuse-branch state.

- [ ] **Step 3: Thread through request and createArgs**

- `useComposerState.ts` request literal (~4109): add `provisionServices` field.
- `worktrees.ts` `createWorktree`: accept and copy into `createArgs` as `provisionServices: request.provisionServices`, `serviceProvisionId: creationId` (the creation flow already has `creationId`; pass it the same way `worktree-creation-flow.ts:140-168` passes positional args — extend whichever args object/positional list carries the request there, following `ephemeralVmRuntimeId`'s existing route).

- [ ] **Step 4: Stream provisioning log**

In `worktree-creation-flow.ts` `executeWorktreeCreation` (line 129), when `preparedRequest.provisionServices`, before the `createWorktree` call: set phase `'provisioning-services'` is NOT correct up-front (creation starts with git work) — instead subscribe:

```ts
const unsubscribeServiceEvents = window.api.worktreeServices.onProvisionEvent?.((event) => {
  if (event.provisionId !== creationId) {
    return
  }
  const store = useAppStore.getState()
  const pending = store.pendingWorktreeCreations[creationId]
  if (!pending) {
    return
  }
  store.updatePendingWorktreeCreation(creationId, {
    phase: 'provisioning-services',
    provisioningLog: ((pending.provisioningLog ?? '') + event.chunk).slice(-12_000)
  })
})
```

Unsubscribe in a `finally` around the create call (mirror `ephemeral-vm-worktree-creation.ts:22-43`'s subscribe/finally shape). After successful creation with `provisionServices`, call `useAppStore.getState().hydrateWorktreeServices()`.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm vitest run src/renderer/src/lib/setup-script-prompt.test.ts src/renderer/src/lib/worktree-activation.test.ts`
Expected: PASS (no regressions in creation-flow adjacents). Manual check happens in Task 12.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/pending-worktree-creation.ts src/renderer/src/hooks/useComposerState.ts src/renderer/src/components/NewWorkspaceComposerCard.tsx src/renderer/src/store/slices/worktrees.ts src/renderer/src/lib/worktree-creation-flow.ts
git commit -m "feat(services): isolated-services opt-in in the new-workspace composer"
```

---

### Task 10: Worktree card badge + retry action

**Files:**
- Modify: `src/renderer/src/components/sidebar/WorktreeCardMetadataStatusBadges.tsx` — new `ServicesStatusBadge`
- Modify: `src/renderer/src/components/sidebar/WorktreeCard.tsx` — render badge when a services record exists for the worktree
- Test: extend `WorktreeCardMetadataStatusBadges`' existing test file if present (check for a sibling `.test.tsx`; if none exists, skip component test — the badge is presentational)

**Interfaces:**
- Consumes: store `worktreeServicesEnv` is insufficient here (it only holds `ready` env) — extend the Task 8 slice with `worktreeServicesStatus: Record<string, WorktreeServicesStatus>` populated in the same `hydrateWorktreeServices()` pass; `window.api.worktreeServices.retry` (Task 5).

- [ ] **Step 1: Extend hydration with status map** (in `hydrateWorktreeServices`, alongside env: `worktreeServicesStatus[record.worktreeId] = record.status`).

- [ ] **Step 2: Badge component** — copy `IssueStateBadge` (lines 10–58) tone convention:

```tsx
export function ServicesStatusBadge({ status }: { status: WorktreeServicesStatus }): React.JSX.Element {
  if (status === 'create_failed' || status === 'destroy_failed') {
    return (
      <MetadataStatusBadge
        label={translate('auto.components.sidebar.WorktreeCardMetadataStatusBadges.servicesFailed', 'Services: Failed')}
        className="border-red-500/25 bg-red-500/5 text-red-600 dark:text-red-300"
      >
        <DatabaseZap />
      </MetadataStatusBadge>
    )
  }
  return (
    <MetadataStatusBadge
      label={translate('auto.components.sidebar.WorktreeCardMetadataStatusBadges.servicesReady', 'Services')}
      className="border-sky-500/25 bg-sky-500/5 text-sky-600 dark:text-sky-300"
    >
      <Database />
    </MetadataStatusBadge>
  )
}
```

(`Database`, `DatabaseZap` from `lucide-react`.)

- [ ] **Step 3: Render + retry** — in `WorktreeCard.tsx`, read `worktreeServicesStatus[worktree.id]`; render the badge when defined. For `create_failed`, add a context-menu/action entry "Retry services provisioning" (find the card's existing action/context-menu surface and append) calling:

```ts
await window.api.worktreeServices.retry({ worktreeId: worktree.id })
await useAppStore.getState().hydrateWorktreeServices()
```

with a `toast.error(...)` on rejection (import `toast` from `sonner`, already used in `ephemeral-vm-worktree-creation.ts`).

- [ ] **Step 4: Verify** — `pnpm typecheck`; run the sidebar test suites: `pnpm vitest run src/renderer/src/components/sidebar`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/sidebar/WorktreeCardMetadataStatusBadges.tsx src/renderer/src/components/sidebar/WorktreeCard.tsx src/renderer/src/store/slices/worktrees.ts
git commit -m "feat(services): worktree card services badge with retry action"
```

---

### Task 11: Recipe diagnostics surface + remote-repo follow-up note

**Files:**
- Modify: `src/renderer/src/components/settings/RepositoryHooksSection.tsx` (locate via its test `RepositoryHooksSection.test.ts`)
- Modify: `docs/reference/2026-07-07-worktree-services-design.md` — append an "Implementation notes" line documenting that remote (SSH) provisioning is a follow-up and where it plugs in (`runRemoteArchiveHook` pattern, `src/main/ipc/worktrees.ts:322`)

**Interfaces:**
- Consumes: `OrcaHooks.serviceDiagnostics` (Task 1) — reaches the renderer wherever repo hooks are already exposed (follow how `RepositoryHooksSection` obtains hook data today; reuse that channel, extend its payload type if needed).

- [ ] **Step 1: Read `RepositoryHooksSection.tsx` and its data source.** Add a small diagnostics list rendered when `serviceDiagnostics` is non-empty: one line per diagnostic, `text-destructive` styling consistent with existing error text in that section (check STYLEGUIDE tokens; reuse whatever the section uses for hook errors). Include the missing-`destroy` warning: when a parsed service has no `destroy`, render `Service "<id>" has no destroy command — containers will outlive worktrees.` (compute in the component from `hooks.services`; no new parse-time diagnostic needed).

- [ ] **Step 2: Extend `RepositoryHooksSection.test.ts`** with one case: hooks payload containing a `serviceDiagnostics` entry and a destroy-less service renders both messages. Follow the file's existing render/assert style.

- [ ] **Step 3: Run** `pnpm vitest run src/renderer/src/components/settings/RepositoryHooksSection.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/RepositoryHooksSection.tsx src/renderer/src/components/settings/RepositoryHooksSection.test.ts docs/reference/2026-07-07-worktree-services-design.md
git commit -m "feat(services): surface service recipe diagnostics in repository settings"
```

---

### Task 12: End-to-end smoke verification (manual + full suite)

**Files:** none (verification only)

- [x] **Step 1: Full test + lint pass**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm check:max-lines-ratchet`
Expected: all green; zero new baseline entries.

- [ ] **Step 2: Manual smoke (dev app)**

In a scratch git repo, write an `orca.yaml`:

```yaml
services:
  - id: marker
    name: Marker file
    create: echo "up $ORCA_WORKTREE_SLUG $ORCA_PORT_0" > "/tmp/orca-svc-$ORCA_WORKTREE_SLUG"
    destroy: rm -f "/tmp/orca-svc-$ORCA_WORKTREE_SLUG"
    env:
      MARKER_PORT: ${ORCA_PORT_0}
```

Then: create a worktree with the checkbox ON → marker file exists, `echo $MARKER_PORT` in the worktree terminal prints `20000` (first slot), badge shows on the card, second opted-in worktree gets `20010`. Delete the first worktree → its marker file is gone and a new worktree reuses slot 0. Create with checkbox OFF → no marker, no badge, no env var.

- [ ] **Step 3: Report results** — paste the manual-check outcomes in the PR/summary; failures loop back to the owning task.

---

## Self-Review Notes

- Spec coverage: schema (T1), slug/ports/substitution (T2), slot store (T3), lifecycle + 10-min timeout + reverse-order rollback (T4), IPC/retry/events (T5), create-flow + setup env (T6), destroy-on-remove + orphan cleanup (T7), PTY injection incl. agents (T8), opt-in checkbox + streamed log + phase label (T9), badge + retry (T10), doctor-style diagnostics (T11), verification (T12).
- Deviation from spec: SSH/remote provisioning is deferred (checkbox hidden for `repo.connectionId` repos); design doc gets an implementation note in T11. WSL is covered via the `runHook` WSL branch pattern in T4.
- Line refs are anchors from exploration on 2026-07-07 (commit `59b6b89fc` era); re-locate by symbol name if drifted.
