import childProcess from 'node:child_process'

/**
 * Defaults `windowsHide: true` for every child_process API in this process.
 *
 * Why: Electron's bundled Node patches the `windowsHide` default to true, and
 * the daemon historically ran under Electron-as-Node, so none of its spawn
 * call sites (PowerShell CIM probes, node-pty's console-list helper, agent
 * detection) pass the flag. Hosted by a standalone node.exe the default is
 * false — with a console-subsystem host every such child allocates a console,
 * which flashes a visible window (Windows Terminal when it is the default
 * host) on each periodic probe. Restore the Electron default process-wide.
 */

const PATCHED_APIS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork'
] as const

let installed = false

function isPlainOptionsObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value)
  )
}

/**
 * Returns the argument list with `windowsHide: true` merged into its options
 * object. Handles every child_process signature: options may sit at any
 * position after the command, may be followed by a callback (exec/execFile),
 * or may be absent entirely. An explicit caller-provided windowsHide wins.
 */
export function withHiddenConsoleDefault(args: unknown[]): unknown[] {
  for (let i = 1; i < args.length; i++) {
    if (isPlainOptionsObject(args[i])) {
      const next = [...args]
      next[i] = { windowsHide: true, ...(args[i] as Record<string, unknown>) }
      return next
    }
  }
  // No options object: insert one before a trailing callback, else append.
  const next = [...args]
  const insertAt = typeof next.at(-1) === 'function' ? next.length - 1 : next.length
  next.splice(insertAt, 0, { windowsHide: true })
  return next
}

export function installHiddenConsoleChildDefaults(): void {
  if (installed || process.platform !== 'win32') {
    return
  }
  installed = true
  for (const name of PATCHED_APIS) {
    const original = childProcess[name] as (...args: unknown[]) => unknown
    const wrapped = (...args: unknown[]): unknown => original(...withHiddenConsoleDefault(args))
    // Why: exec/execFile carry promisify custom symbols; copy them so
    // util.promisify keeps returning {stdout, stderr} promises.
    Object.setPrototypeOf(wrapped, original)
    for (const sym of Object.getOwnPropertySymbols(original)) {
      Object.defineProperty(wrapped, sym, Object.getOwnPropertyDescriptor(original, sym)!)
    }
    ;(childProcess as Record<string, unknown>)[name] = wrapped
  }
}

// Why install on import (not via an exported call): modules capture bindings
// like `promisify(execFile)` at their own import time, so the patch must land
// before ANY other daemon module evaluates. daemon-entry imports this module
// first for that reason.
installHiddenConsoleChildDefaults()
