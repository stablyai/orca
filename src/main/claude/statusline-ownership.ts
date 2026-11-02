import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { readManagedHookHostIdentity } from '../agent-hooks/managed-hook-owner-identity'
import {
  withManagedHookInstallLock,
  waitForManagedHookPreparation
} from '../agent-hooks/managed-hook-install-lock'
import { isPlainObject, parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import {
  writeHooksJsonAsync,
  type NativeHookDestination
} from '../agent-hooks/hooks-json-write-async'

export type SystemOperation = { signal?: AbortSignal; shouldContinue?: () => boolean }
const operations = new Map<string, AbortController>()

export function requestClaudeSystemOperation(home: string, options: SystemOperation) {
  operations.get(home)?.abort()
  const controller = new AbortController()
  operations.set(home, controller)
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const check = () => {
    signal.throwIfAborted()
    if (options.shouldContinue?.() === false) {
      throw new Error('Claude hook installation was canceled')
    }
  }
  return {
    signal,
    check,
    finish: () => {
      if (operations.get(home) === controller) {
        operations.delete(home)
      }
    }
  }
}

export type StatusLineOwner = NativeHookDestination & { phase: 'managed' | 'own-change' }

let evidenceChains = 0

// Abandoned raw reads keep their capacity; their only continuation releases the slot.
export async function readStatusLineEvidence<T>(
  signal: AbortSignal,
  read: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  if (evidenceChains >= 2) {
    throw new Error('Claude statusline evidence is still being read')
  }
  evidenceChains++
  const raw = Promise.resolve().then(read)
  void raw.then(
    () => {
      evidenceChains--
    },
    () => {
      evidenceChains--
    }
  )
  let abort!: () => void
  try {
    return await Promise.race([
      raw,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
        }
      })
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

type OwnershipDocument = { schema: 1; revision: string; destinations: StatusLineOwner[] }

export async function readSystemHookSettings(path: string) {
  try {
    const raw = await readFile(path, 'utf8')
    const config = parseHooksJsonText(raw)
    if (!config) {
      throw new Error(`Could not parse Claude settings.json at ${path}`)
    }
    return { raw, config }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { raw: null, config: {} }
    }
    throw error
  }
}

export async function existingStatusLineDestination(
  path: string
): Promise<NativeHookDestination | null> {
  const link = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (link) {
    return await selectedStatusLineDestination(link.isSymbolicLink() ? await realpath(path) : path)
  }
  try {
    return await selectedStatusLineDestination(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function selectedStatusLineDestination(
  selectedPath: string
): Promise<NativeHookDestination> {
  const parent = await realpath(dirname(selectedPath))
  const identity = await stat(parent, { bigint: true })
  if (!identity.isDirectory() || identity.ino <= 0n || identity.dev <= 0n) {
    throw new Error('Claude settings parent identity is unavailable')
  }
  return {
    path: join(parent, basename(selectedPath)),
    parent: { dev: String(identity.dev), ino: String(identity.ino) }
  }
}

export function sameStatusLineDestination(a: NativeHookDestination, b: NativeHookDestination) {
  return a.path === b.path && a.parent.dev === b.parent.dev && a.parent.ino === b.parent.ino
}

function parseDocument(value: unknown): OwnershipDocument {
  if (
    !isPlainObject(value) ||
    value.schema !== 1 ||
    typeof value.revision !== 'string' ||
    !value.revision ||
    !Array.isArray(value.destinations)
  ) {
    throw new Error('Could not read Claude statusline ownership')
  }
  const destinations: StatusLineOwner[] = []
  const names = new Set<string>()
  for (const entry of value.destinations) {
    if (
      !isPlainObject(entry) ||
      typeof entry.path !== 'string' ||
      !isAbsolute(entry.path) ||
      !isPlainObject(entry.parent) ||
      typeof entry.parent.dev !== 'string' ||
      !/^[1-9]\d*$/.test(entry.parent.dev) ||
      typeof entry.parent.ino !== 'string' ||
      !/^[1-9]\d*$/.test(entry.parent.ino) ||
      (entry.phase !== 'managed' && entry.phase !== 'own-change') ||
      names.has(entry.path)
    ) {
      throw new Error('Could not read Claude statusline destinations')
    }
    names.add(entry.path)
    destinations.push({
      path: entry.path,
      parent: { dev: entry.parent.dev, ino: entry.parent.ino },
      phase: entry.phase
    })
  }
  return { schema: 1, revision: value.revision, destinations }
}

export class StatusLineOwnership {
  document: OwnershipDocument = { schema: 1, revision: '', destinations: [] }
  constructor(
    readonly path: string,
    private readonly check: () => void = () => {}
  ) {}

  async read() {
    try {
      this.document = parseDocument(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    return this.document
  }

  async save(destinations: StatusLineOwner[], reset = false) {
    if (!reset && JSON.stringify(destinations) === JSON.stringify(this.document.destinations)) {
      return
    }
    const next: OwnershipDocument = { schema: 1, revision: randomUUID(), destinations }
    const serialized = `${JSON.stringify(next, null, 2)}\n`
    this.check()
    try {
      await writeHooksJsonAsync(this.path, next, {
        privateMode: true,
        serialized,
        beforePublish: async () => this.check()
      })
    } catch (error) {
      // A successful rename followed by failed cleanup still establishes exactly this revision.
      if ((await readFile(this.path, 'utf8').catch(() => null)) !== serialized) {
        throw error
      }
    }
    this.document = next
  }

  async set(destination: NativeHookDestination, phase?: StatusLineOwner['phase']) {
    const entries = this.document.destinations.filter((owner) => owner.path !== destination.path)
    const previous = this.document.destinations.find((owner) => owner.path === destination.path)
    if (
      phase &&
      previous &&
      sameStatusLineDestination(previous, destination) &&
      previous.phase === phase
    ) {
      return
    }
    if (phase) {
      entries.push({ ...destination, phase })
    }
    await this.save(entries)
  }
}

const scopePreparations = new Map<string, Promise<string>>()
export async function withClaudeSystemScope<T>(
  home: string,
  signal: AbortSignal,
  run: (store: () => StatusLineOwnership) => Promise<T>,
  check: () => void = () => signal.throwIfAborted()
): Promise<T> {
  const root = join(home, '.orca', 'agent-hooks', 'claude-statusline')
  let preparation = scopePreparations.get(root)
  if (!preparation) {
    preparation = (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      if (!(await lstat(root)).isDirectory()) {
        throw new Error('Claude statusline storage is not a private directory')
      }
      if (process.platform !== 'win32') {
        await chmod(root, 0o700)
      }
      return await readManagedHookHostIdentity()
    })()
    scopePreparations.set(root, preparation)
    void preparation.then(
      () => scopePreparations.delete(root),
      () => scopePreparations.delete(root)
    )
  }
  const prepared = preparation
  const host = await waitForManagedHookPreparation(prepared, signal)
  signal.throwIfAborted()
  return await withManagedHookInstallLock(
    home,
    signal,
    async () => {
      signal.throwIfAborted()
      return await run(() => {
        if (host.startsWith('runtime:')) {
          throw new Error('Claude statusline host identity is unavailable')
        }
        return new StatusLineOwnership(
          join(root, `${createHash('sha256').update(host).digest('hex')}.json`),
          check
        )
      })
    },
    host,
    { lockParent: join(root, 'lock'), waitTimeoutMs: 250, readEvidence: readStatusLineEvidence }
  )
}
