import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

// Maps each Orca agent session (its stable ORCA_PANE_KEY) to a short, addressable
// handle used in the shared Matrix room: outbound messages are prefixed
// `[orca <handle>]` and inbound messages target a session via `@<handle>`. The
// mapping is bijective and persisted so a handle stays stable across restarts
// (the pane key itself is restored with the workspace session).

const MIN_HANDLE_LENGTH = 4
// Cap a speaking handle so a long branch/display name stays addressable and the
// room prefix doesn't dominate the line; the inbound parser has no length limit.
const MAX_HANDLE_LENGTH = 24
// Base36 of a sha256 digest yields [0-9a-z], a subset of the inbound handle
// charset ([A-Za-z0-9_-]); lowercase keeps matching case-insensitive and simple.
const HANDLE_BASE = 36

type RegistryFile = {
  byPaneKey: Record<string, string>
  byHandle: Record<string, string>
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function registryPath(): string {
  return join(getOrcaDir(), 'matrix-handles.json')
}

// Null-prototype map so a handle that happens to spell an Object.prototype member
// (`constructor`, `toString`, `valueOf`, …) can't read an inherited value:
// `map[handle]` is then strictly own-key-or-undefined. Also hardens lookups
// against prototype pollution from a tampered registry file. The registry schema
// is a flat string→string map, so a shallow re-key is sufficient — there are no
// nested objects to sanitize.
function asNullProtoMap(source: Record<string, string>): Record<string, string> {
  return Object.assign(Object.create(null) as Record<string, string>, source)
}

function emptyRegistry(): RegistryFile {
  return { byPaneKey: asNullProtoMap({}), byHandle: asNullProtoMap({}) }
}

function loadRegistry(): RegistryFile {
  try {
    if (!existsSync(registryPath())) {
      return emptyRegistry()
    }
    const parsed = JSON.parse(readFileSync(registryPath(), { encoding: 'utf-8' })) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      'byPaneKey' in parsed &&
      'byHandle' in parsed &&
      typeof (parsed as RegistryFile).byPaneKey === 'object' &&
      typeof (parsed as RegistryFile).byHandle === 'object'
    ) {
      const file = parsed as RegistryFile
      // Re-key onto null-prototype maps so inherited Object members never leak
      // into handle/pane-key lookups (see asNullProtoMap).
      return { byPaneKey: asNullProtoMap(file.byPaneKey), byHandle: asNullProtoMap(file.byHandle) }
    }
  } catch {
    // A corrupt registry is non-fatal: fall back to empty and re-mint handles.
  }
  return emptyRegistry()
}

function saveRegistry(registry: RegistryFile): void {
  mkdirSync(getOrcaDir(), { recursive: true })
  writeFileSync(registryPath(), JSON.stringify(registry), { encoding: 'utf-8', mode: 0o600 })
}

// Deterministic candidate so the same pane key tends to mint the same handle even
// on a fresh registry; collisions extend the slice until unique.
function candidateHandle(paneKey: string, length: number): string {
  const digest = createHash('sha256').update(paneKey).digest()
  const slug = BigInt(`0x${digest.toString('hex')}`).toString(HANDLE_BASE)
  return slug.slice(0, length)
}

// Turns a human label (worktree/repo display name, branch) into an addressable
// handle: lowercased, every run of non-[a-z0-9] collapsed to a single dash (so
// `feat/matrix-adapter` → `feat-matrix-adapter`), trimmed, capped. Returns null
// when nothing meaningful survives (e.g. only symbols), so the caller falls back
// to the deterministic slug rather than minting an empty handle.
function slugifyHandle(label: string): string | null {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_HANDLE_LENGTH)
    .replace(/-+$/g, '')
  return slug.length >= MIN_HANDLE_LENGTH ? slug : null
}

// Persists a freshly minted (paneKey, handle) pair after a collision-free handle
// has been chosen. The byHandle index makes inbound @handle lookups O(1).
// Immutable: builds new maps instead of mutating the loaded registry, so a caller
// still holding the pre-write object sees no surprise side effect.
function persistHandle(registry: RegistryFile, paneKey: string, handle: string): string {
  saveRegistry({
    byPaneKey: { ...registry.byPaneKey, [paneKey]: handle },
    byHandle: { ...registry.byHandle, [handle]: paneKey }
  })
  return handle
}

// Deterministic-slug fallback used when no speaking label is available: extends
// the sha256 slice until the handle is unique within the registry.
function mintFallbackHandle(registry: RegistryFile, paneKey: string): string {
  let length = MIN_HANDLE_LENGTH
  let handle = candidateHandle(paneKey, length)
  while (registry.byHandle[handle] && registry.byHandle[handle] !== paneKey) {
    length += 1
    handle = candidateHandle(paneKey, length)
  }
  return persistHandle(registry, paneKey, handle)
}

// Mints (and persists) a SPEAKING handle for a pane key from a human label, or
// falls back to the deterministic slug when the label yields nothing usable.
// Stable: once a pane key has any handle it is returned unchanged, so a session
// keeps the same name across restarts and never flips mid-session. Collisions on
// the slug (two sessions sharing a branch/display name) get a `-2`, `-3`, … suffix.
export function registerSessionHandle(paneKey: string, preferredLabel?: string): string {
  const registry = loadRegistry()
  const existing = registry.byPaneKey[paneKey]
  if (existing) {
    return existing
  }
  const base = preferredLabel ? slugifyHandle(preferredLabel) : null
  if (!base) {
    return mintFallbackHandle(registry, paneKey)
  }
  let handle = base
  let suffix = 2
  while (registry.byHandle[handle] && registry.byHandle[handle] !== paneKey) {
    const tag = `-${suffix}`
    // Keep the disambiguated handle within MAX_HANDLE_LENGTH: trim the base to
    // make room for the suffix and re-trim any dash the cut exposed.
    handle = `${base.slice(0, MAX_HANDLE_LENGTH - tag.length).replace(/-+$/g, '')}${tag}`
    suffix += 1
  }
  return persistHandle(registry, paneKey, handle)
}

// Returns the handle for a pane key, minting a deterministic-slug one on first
// use. Callers with a human label should prefer registerSessionHandle so the
// handle reads like the session (e.g. `matrix-adapter`) instead of `3ywa`.
export function handleForPaneKey(paneKey: string): string {
  return registerSessionHandle(paneKey)
}

// Resolves an inbound handle back to its pane key, or null if unknown.
export function paneKeyForHandle(handle: string): string | null {
  const normalized = handle.toLowerCase()
  const registry = loadRegistry()
  return registry.byHandle[normalized] ?? null
}
