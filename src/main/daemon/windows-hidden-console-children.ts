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
    ;(childProcess as Record<string, unknown>)[name] = wrapChildProcessApi(
      childProcess[name] as (...args: unknown[]) => unknown
    )
  }
}

export function wrapChildProcessApi(
  original: (...args: unknown[]) => unknown
): (...args: unknown[]) => unknown {
  const wrapped = (...args: unknown[]): unknown => original(...withHiddenConsoleDefault(args))
  Object.setPrototypeOf(wrapped, original)
  // Why: exec/execFile carry a util.promisify.custom implementation that
  // internally calls the ORIGINAL function — copying the symbol verbatim lets
  // every `promisify(execFile)` call site bypass the wrapper (rc.6 shipped
  // this bug: the daemon's CIM probes are promisified and kept flashing).
  // Wrap each symbol-attached function so the injection applies there too.
  for (const sym of Object.getOwnPropertySymbols(original)) {
    const desc = Object.getOwnPropertyDescriptor(original, sym)!
    if (typeof desc.value === 'function') {
      const originalCustom = desc.value as (...args: unknown[]) => unknown
      desc.value = (...args: unknown[]): unknown =>
        originalCustom(...withHiddenConsoleDefault(args))
    }
    Object.defineProperty(wrapped, sym, desc)
  }
  return wrapped
}

// Why install on load: this file is built as its own self-contained bundle
// entry (electron.vite.config.ts) and preloaded into the daemon via
// `node --require` (daemon-init.ts). An in-graph import cannot work: rollup's
// CJS output hoists chunk requires above inlined module code, so sibling
// chunks capture `promisify(execFile)` before any "first import" executes.
// --require runs before the whole graph loads, immune to bundler ordering.
// It must therefore never import anything that could be split into a chunk.
installHiddenConsoleChildDefaults()
