// Promotion and GC share a lock; uncertain process evidence retains every runtime.
// Legacy version directories supply references and diagnostics but are never deleted here.
import { randomInt } from 'node:crypto'
import type { RemoteInstallTransport } from './remote-install-transport'
import { RUNTIME_STORE_STAGE_PREFIX } from './orcad-remote-node-runtime'
import { inventoryRemoteInstallDirs } from './remote-install-model'
import {
  parseRuntimeStoreInventory,
  RUNTIME_STORE_ENTRY_NAME,
  RUNTIME_STORE_TOMBSTONE_NAME,
  RUNTIME_STORE_TOMBSTONE_PREFIX,
  type RuntimeStoreInventory
} from './remote-node-runtime-store-inventory'
import {
  remoteNodeRuntimeStoreDir,
  tryWithRuntimeStoreLock
} from './remote-node-runtime-store-lock'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { INSTALL_LOCK_STALE_MS } from './remote-install-lock'
import {
  moveRemoteTreeCommand,
  removeRemoteTreeCommand,
  restoreRemoteTreeCommand
} from '../../ssh/ssh-remote-commands'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import {
  hostRuntimeStoreInventoryCommand,
  windowsSweepStaleRuntimeStagesCommand
} from './remote-node-runtime-store-windows'

const MAX_REMOVALS_PER_PASS = 8
const ABANDONED_TOMBSTONE_MS = 30 * 60_000

type RuntimeStoreGcPlan = {
  remove: string[]
  purgeTombstones: string[]
  kept: string[]
}

function holdReason(
  sha: string,
  inventory: RuntimeStoreInventory,
  pins: ReadonlySet<string>
): string | null {
  if (!inventory.processCheckRan) {
    return 'process check unavailable'
  }
  if (pins.has(sha)) {
    return 'pinned'
  }
  if (inventory.referenced.has(sha)) {
    return 'referenced'
  }
  if (inventory.held.has(sha)) {
    return 'in use by a process'
  }
  return null
}

export function planRuntimeStoreGc(
  inventory: RuntimeStoreInventory,
  currentPins: readonly string[],
  now: number = Date.now()
): RuntimeStoreGcPlan {
  const pins = new Set(currentPins)
  // Retain the newest verified non-current runtime as a previous-pin fallback.
  const previous = inventory.verifiedNewestFirst
    .map((name) => RUNTIME_STORE_ENTRY_NAME.exec(name)?.[1])
    .find((sha): sha is string => !!sha && !pins.has(sha))
  if (previous) {
    pins.add(previous)
  }
  const verified = new Set(inventory.verifiedNewestFirst)
  const plan: RuntimeStoreGcPlan = { remove: [], purgeTombstones: [], kept: [] }
  for (const name of inventory.entries) {
    const entry = RUNTIME_STORE_ENTRY_NAME.exec(name)
    if (entry) {
      // Installers own unverified runtimes, whether mid-promotion or torn.
      const idle = verified.has(name) && holdReason(entry[1], inventory, pins) === null
      if (idle && plan.remove.length < MAX_REMOVALS_PER_PASS) {
        plan.remove.push(name)
      } else {
        plan.kept.push(name)
      }
      continue
    }
    const tombstone = RUNTIME_STORE_TOMBSTONE_NAME.exec(name)
    if (
      tombstone &&
      now - Number(tombstone[2]) >= ABANDONED_TOMBSTONE_MS &&
      holdReason(tombstone[1], inventory, pins) === null
    ) {
      plan.purgeTombstones.push(name)
    }
  }
  return plan
}

type RuntimeStoreGcResult =
  | { state: 'skipped'; reason: string }
  | {
      state: 'collected'
      removed: string[]
      kept: string[]
      legacyDirs: string[]
      sweptStages: string[]
    }

const SWEPT_STAGE = 'SWEPT'

/** File mtimes reveal active uploads; directory mtimes alone do not. Failed listings keep stages. */
export function sweepStaleRuntimeStagesCommand(
  storeDir: string,
  host?: RemoteHostPlatform
): string {
  const staleMinutes = Math.ceil(INSTALL_LOCK_STALE_MS / 60_000)
  if (host && isWindowsRemoteHost(host)) {
    return windowsSweepStaleRuntimeStagesCommand(storeDir, staleMinutes, SWEPT_STAGE)
  }
  return [
    `for s in ${quotePosixShell(storeDir)}/${RUNTIME_STORE_STAGE_PREFIX}*; do`,
    '  [ -d "$s" ] && [ ! -L "$s" ] || continue',
    `  recent=$(find "$s" -mmin -${staleMinutes} -print 2>/dev/null) || continue`,
    '  [ -z "$recent" ] || continue',
    `  rm -rf -- "$s" && printf '${SWEPT_STAGE} %s\n' "\${s##*/}"`,
    'done',
    'true'
  ].join('\n')
}

export function parseSweptRuntimeStages(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${SWEPT_STAGE} `))
    .map((line) => line.slice(SWEPT_STAGE.length + 1))
}

function exec(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  command: string,
  signal?: AbortSignal
): Promise<string> {
  return execCommand(conn, command, { wrapCommand: !isWindowsRemoteHost(host), signal })
}

async function readInventory(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  remoteHome: string,
  signal?: AbortSignal
): Promise<RuntimeStoreInventory | null> {
  try {
    return parseRuntimeStoreInventory(
      await exec(conn, host, hostRuntimeStoreInventoryCommand(host, remoteHome), signal)
    )
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return null
  }
}

/** Confirmed failures retain runtimes; unconfirmed termination stops the caller's cleanup chain. */
export async function gcRemoteNodeRuntimeStore(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  remoteHome: string,
  options: { currentPins: readonly string[]; signal?: AbortSignal }
): Promise<RuntimeStoreGcResult> {
  const store = remoteNodeRuntimeStoreDir(host, remoteHome)
  const locked = await tryWithRuntimeStoreLock(
    conn,
    host,
    store,
    () => collectHoldingStoreLock(conn, host, remoteHome, store, options),
    options.signal
  )
  return locked?.value ?? { state: 'skipped', reason: 'runtime store lock is held or absent' }
}

async function collectHoldingStoreLock(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  remoteHome: string,
  store: string,
  options: { currentPins: readonly string[]; signal?: AbortSignal }
): Promise<RuntimeStoreGcResult> {
  const sweptStages = await exec(
    conn,
    host,
    sweepStaleRuntimeStagesCommand(store, host),
    options.signal
  )
    .then(parseSweptRuntimeStages)
    .catch((error: unknown) => {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return []
    })
  const inventory = await readInventory(conn, host, remoteHome, options.signal)
  if (!inventory) {
    return { state: 'skipped', reason: 'runtime store inventory was unverifiable' }
  }
  const legacy = inventoryRemoteInstallDirs(inventory.dirNames)
  const legacyDirs = [...legacy.relay, ...legacy.orcad]
  const plan = planRuntimeStoreGc(inventory, options.currentPins)
  const removed: string[] = []
  const kept = [...plan.kept]
  for (const name of plan.purgeTombstones) {
    if (await removeTree(conn, host, joinRemotePath(host, store, name), options.signal)) {
      removed.push(name)
    }
  }
  for (const name of plan.remove) {
    const sha = RUNTIME_STORE_ENTRY_NAME.exec(name)?.[1] ?? ''
    const entryDir = joinRemotePath(host, store, name)
    const tombstone = joinRemotePath(
      host,
      store,
      `${RUNTIME_STORE_TOMBSTONE_PREFIX}${name}.${randomInt(1, 2 ** 47)}.${Date.now()}`
    )
    if (!(await moveTree(conn, host, entryDir, tombstone, options.signal))) {
      kept.push(name)
      continue
    }
    // Installers may write references after our first scan; restore renamed runtimes they now need.
    const recheck = await readInventory(conn, host, remoteHome, options.signal).catch(
      async (err: unknown) => {
        await restoreTree(conn, host, tombstone, entryDir, options.signal).catch(() => {})
        throw err
      }
    )
    if (!recheck || holdReason(sha, recheck, new Set(options.currentPins)) !== null) {
      await restoreTree(conn, host, tombstone, entryDir, options.signal)
      kept.push(name)
      continue
    }
    if (await removeTree(conn, host, tombstone, options.signal)) {
      removed.push(name)
    } else {
      kept.push(name)
    }
  }
  if (removed.length > 0) {
    const legacyNote =
      legacyDirs.length > 0
        ? `; legacy install dirs left for the migration sweep: ${legacyDirs.join(', ')}`
        : ''
    console.log(`[runtime-store] GC: removed ${removed.join(', ')}${legacyNote}`)
  }
  if (sweptStages.length > 0) {
    console.log(`[runtime-store] GC: swept stale upload stages ${sweptStages.join(', ')}`)
  }
  return { state: 'collected', removed, kept, legacyDirs, sweptStages }
}

async function moveTree(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  source: string,
  destination: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    return (
      (await exec(conn, host, moveRemoteTreeCommand(host, source, destination), signal)).trim() ===
      'MOVED'
    )
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return false
  }
}

async function restoreTree(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  tombstone: string,
  entryDir: string,
  signal?: AbortSignal
): Promise<void> {
  await exec(conn, host, restoreRemoteTreeCommand(host, tombstone, entryDir), signal).catch(
    (err) => {
      if (isUnconfirmedSshCommandTermination(err)) {
        throw err
      }
    }
  )
}

async function removeTree(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  path: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await exec(conn, host, removeRemoteTreeCommand(host, path), signal)
    return true
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return false
  }
}
