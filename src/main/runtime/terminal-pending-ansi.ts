import { detachString, type DetachedString } from '../../shared/detached-string'

const MAX_TERMINAL_PENDING_ANSI_CHARS = 4096

export function retainTerminalPendingAnsi(value: string): DetachedString {
  if (value.length <= MAX_TERMINAL_PENDING_ANSI_CHARS) {
    return detachString(value)
  }
  const introducer = value.slice(0, Math.min(2, value.length))
  const suffixBudget = MAX_TERMINAL_PENDING_ANSI_CHARS - introducer.length
  return detachString(`${introducer}${value.slice(-suffixBudget)}`)
}
