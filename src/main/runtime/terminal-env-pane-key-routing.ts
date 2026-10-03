// A live PTY's environment is fixed at spawn, so its hooks post the pane key exported then even after
// the terminal shows elsewhere; the host routes that key to the terminal's current pane.
import { parsePaneKey } from '../../shared/stable-pane-id'

export type EnvPaneKeyTerminal = {
  ptyId: string
  /** The terminal's current surface as recorded by the runtime. */
  paneKey: string | null
  envPaneKey?: string | null
  connectionId: string | null
}

export type EnvPaneKeyRoutingSource<T extends EnvPaneKeyTerminal> = {
  terminals: Iterable<T>
  isLive: (terminal: T) => boolean
  /** Every pane the terminal is mounted in now; empty when no graph names it. */
  currentPaneKeys: (terminal: T) => readonly string[]
}

/**
 * The pane a hook posting `paneKey` belongs to now, or undefined when the key already names a
 * live pane, no live terminal carries it, or more than one does. Refusing to guess keeps an
 * ambiguous post exactly where it lands today.
 */
export function resolveTerminalPaneForEnvPaneKey<T extends EnvPaneKeyTerminal>(
  paneKey: string,
  source: EnvPaneKeyRoutingSource<T>,
  /** The host the post arrived from; undefined trusts any. A key never crosses hosts. */
  connectionId?: string | null
): string | undefined {
  if (!parsePaneKey(paneKey)) {
    return undefined
  }
  let carrier: T | undefined
  for (const terminal of source.terminals) {
    if (
      (terminal.paneKey !== paneKey && terminal.envPaneKey !== paneKey) ||
      (connectionId !== undefined && terminal.connectionId !== connectionId)
    ) {
      continue
    }
    if (!source.isLive(terminal)) {
      continue
    }
    // A live terminal shows this pane, so the key is not stale.
    if (terminal.paneKey === paneKey) {
      return undefined
    }
    if (carrier) {
      return undefined
    }
    carrier = terminal
  }
  return carrier ? currentPaneOf(carrier, paneKey, source) : undefined
}

export type MovedEnvPaneKey = {
  fromPaneKey: string
  toPaneKey: string
  connectionId: string | null
  ptyId: string
}

/** Every exported key whose terminal now shows another pane, in one indexed pass over the records. */
export function collectMovedEnvPaneKeys<T extends EnvPaneKeyTerminal>(
  source: EnvPaneKeyRoutingSource<T>
): MovedEnvPaneKey[] {
  const live = [...source.terminals].filter((terminal) => source.isLive(terminal))
  const shown = new Set(live.map((terminal) => `${terminal.connectionId}\0${terminal.paneKey}`))
  const carriers = new Map<string, number>()
  for (const terminal of live) {
    if (terminal.envPaneKey) {
      const key = `${terminal.connectionId}\0${terminal.envPaneKey}`
      carriers.set(key, (carriers.get(key) ?? 0) + 1)
    }
  }
  const moved: MovedEnvPaneKey[] = []
  for (const terminal of live) {
    const fromPaneKey = terminal.envPaneKey
    const scoped = `${terminal.connectionId}\0${fromPaneKey}`
    if (
      !fromPaneKey ||
      fromPaneKey === terminal.paneKey ||
      !parsePaneKey(fromPaneKey) ||
      shown.has(scoped) ||
      carriers.get(scoped) !== 1
    ) {
      continue
    }
    const toPaneKey = currentPaneOf(terminal, fromPaneKey, source)
    if (toPaneKey) {
      moved.push({
        fromPaneKey,
        toPaneKey,
        connectionId: terminal.connectionId,
        ptyId: terminal.ptyId
      })
    }
  }
  return moved
}

/** True when no other live terminal shows or exported this terminal's exported key. */
export function ownsEnvPaneKeyAlone<T extends EnvPaneKeyTerminal>(
  terminal: T,
  source: EnvPaneKeyRoutingSource<T>
): boolean {
  const key = terminal.envPaneKey
  if (!key) {
    return false
  }
  for (const other of source.terminals) {
    if (
      other.ptyId !== terminal.ptyId &&
      (other.paneKey === key || other.envPaneKey === key) &&
      source.isLive(other)
    ) {
      return false
    }
  }
  return true
}

function currentPaneOf<T extends EnvPaneKeyTerminal>(
  carrier: T,
  paneKey: string,
  source: EnvPaneKeyRoutingSource<T>
): string | undefined {
  const mounted = new Set(source.currentPaneKeys(carrier))
  if (mounted.size === 0 && carrier.paneKey) {
    mounted.add(carrier.paneKey)
  }
  if (mounted.has(paneKey) || mounted.size !== 1) {
    return undefined
  }
  const [current] = mounted
  return current && parsePaneKey(current) ? current : undefined
}
