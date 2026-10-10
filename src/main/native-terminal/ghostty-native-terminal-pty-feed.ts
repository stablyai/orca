import { parseRemoteRuntimePtyId } from '../../shared/remote-runtime-pty-id'
import type { NativeTerminalFeedModel } from '../runtime/runtime-desktop-surface'
import { loadGhosttyTerminalAddon } from './ghostty-native-terminal-addon'

// Native surfaces fed straight from main's PTY stream. Each bound surface follows main's
// headless model of its PTY: seeded from that model's snapshot, then sent every chunk on the
// same per-PTY write chain, so no byte takes a renderer round trip and seeds can never race
// live output. Panes whose bytes never reach main (paired remote runtimes) keep the renderer
// mirror.

// The runtime's per-PTY headless model; the runtime reaches this feed through its desktop surface.
export type { NativeTerminalFeedModel }

export type NativeTerminalFeedRuntime = {
  // Runs `task` on the PTY's headless model after everything already queued; false if none.
  queueHeadlessTerminalTask: (
    ptyId: string,
    task: (model: NativeTerminalFeedModel) => void
  ) => boolean
}

type Binding = {
  surfaceId: number
  ptyId: string
  runtime: NativeTerminalFeedRuntime
  seededFrom: NativeTerminalFeedModel | null
}

// RIS first: a seed always starts from a blank surface.
const RESET_TERMINAL = '\x1bc'

const bindingsByPty = new Map<string, Map<number, Binding>>()
const bindingsBySurface = new Map<number, Binding>()
// Why: until Ghostty reports the grid of the shown frame its terminal sits on a placeholder
// grid (the size applies asynchronously), and a snapshot painted there lands rows off.
const placedSurfaces = new Set<number>()
let enabled = true
const stats = { seeds: 0, chunks: 0, chars: 0, writes: 0 }
// Why batch: a flood arrives as thousands of small daemon chunks; one addon write per surface
// per event-loop turn keeps the N-API and Ghostty wakeup cost off each chunk.
const pendingBySurface = new Map<number, string[]>()
let flushScheduled = false

function flush(): void {
  flushScheduled = false
  const addon = loadGhosttyTerminalAddon()
  for (const [surfaceId, parts] of pendingBySurface) {
    stats.writes += 1
    addon?.writeOutput(surfaceId, Buffer.from(parts.join(''), 'utf8'))
  }
  pendingBySurface.clear()
}

function send(surfaceId: number, text: string, replacePending = false): void {
  if (text.length === 0) {
    return
  }
  const parts = replacePending ? undefined : pendingBySurface.get(surfaceId)
  if (parts) {
    parts.push(text)
  } else {
    pendingBySurface.set(surfaceId, [text])
  }
  if (!flushScheduled) {
    flushScheduled = true
    setImmediate(flush)
  }
}

function seed(binding: Binding, model: NativeTerminalFeedModel): void {
  const snapshot = model.emulator.getSnapshot()
  binding.seededFrom = model
  stats.seeds += 1
  // Normal history, then the modes (which own an alternate-screen switch), then the active
  // frame; a dangling escape tail goes last so the next live chunk completes it. Unsent
  // chunks are dropped: the model parsed them before this snapshot.
  send(
    binding.surfaceId,
    `${RESET_TERMINAL}${snapshot.scrollbackAnsi ?? ''}${snapshot.rehydrateSequences}${snapshot.snapshotAnsi}${snapshot.pendingEscapeTailAnsi ?? ''}`,
    true
  )
}

export function unbindNativeTerminalSurface(surfaceId: number): void {
  const binding = bindingsBySurface.get(surfaceId)
  if (!binding) {
    return
  }
  bindingsBySurface.delete(surfaceId)
  pendingBySurface.delete(surfaceId)
  const forPty = bindingsByPty.get(binding.ptyId)
  forPty?.delete(surfaceId)
  if (forPty?.size === 0) {
    bindingsByPty.delete(binding.ptyId)
  }
}

// True when main will feed the surface; false leaves it to the renderer mirror.
export function bindNativeTerminalPty(
  surfaceId: number,
  ptyId: string,
  runtime: NativeTerminalFeedRuntime | null
): boolean {
  unbindNativeTerminalSurface(surfaceId)
  if (!enabled || !runtime || parseRemoteRuntimePtyId(ptyId)) {
    return false
  }
  const binding: Binding = { surfaceId, ptyId, runtime, seededFrom: null }
  bindingsBySurface.set(surfaceId, binding)
  const forPty = bindingsByPty.get(ptyId) ?? new Map<number, Binding>()
  forPty.set(surfaceId, binding)
  bindingsByPty.set(ptyId, forPty)
  if (placedSurfaces.has(surfaceId)) {
    queueSeed(binding)
  }
  return true
}

function queueSeed(binding: Binding): void {
  // Why no model is fine: a PTY that has produced nothing yet seeds on its first chunk.
  binding.runtime.queueHeadlessTerminalTask(binding.ptyId, (model) => {
    if (bindingsBySurface.get(binding.surfaceId) === binding) {
      seed(binding, model)
    }
  })
}

// Host hook: Ghostty reported the grid for the surface's shown frame.
export function nativeTerminalSurfacePlaced(surfaceId: number): void {
  if (placedSurfaces.has(surfaceId)) {
    return
  }
  placedSurfaces.add(surfaceId)
  const binding = bindingsBySurface.get(surfaceId)
  if (binding) {
    queueSeed(binding)
  }
}

export function forgetNativeTerminalSurface(surfaceId: number): void {
  unbindNativeTerminalSurface(surfaceId)
  placedSurfaces.delete(surfaceId)
}

// Runtime hook, on the PTY's write chain after `model` parsed `data`.
export function feedNativeTerminalPtyData(
  ptyId: string,
  model: NativeTerminalFeedModel,
  data: string
): void {
  const bindings = bindingsByPty.get(ptyId)
  if (!bindings) {
    return
  }
  for (const binding of bindings.values()) {
    if (!placedSurfaces.has(binding.surfaceId)) {
      continue
    }
    // A model created or replaced since the last seed (first byte, gap recovery, renderer
    // hydration): its snapshot already includes `data`.
    if (binding.seededFrom !== model) {
      seed(binding, model)
      continue
    }
    stats.chunks += 1
    stats.chars += data.length
    send(binding.surfaceId, data)
  }
}

// Runtime hook, on the write chain after main changed the model outside the byte stream (clear).
export function reseedNativeTerminalPty(ptyId: string, model: NativeTerminalFeedModel): void {
  for (const binding of bindingsByPty.get(ptyId)?.values() ?? []) {
    if (placedSurfaces.has(binding.surfaceId)) {
      seed(binding, model)
    }
  }
}

// Unpackaged debug hooks: compare the main feed against the renderer mirror.
export function nativeTerminalFeedDebug(setEnabled?: boolean): typeof stats & { enabled: boolean } {
  if (typeof setEnabled === 'boolean') {
    enabled = setEnabled
  }
  return { ...stats, enabled }
}
