import { parse } from 'smol-toml'
import { isPlainObject, type HookDefinition } from '../agent-hooks/installer-utils'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

export function extractInlineCodexHooks(config: string): Record<string, HookDefinition[]> {
  const parsed = parse(config)
  if (!isPlainObject(parsed.hooks)) {
    return {}
  }

  const hooks: Record<string, HookDefinition[]> = {}
  for (const [eventName, value] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(value)) {
      continue
    }
    const definitions: HookDefinition[] = []
    for (const candidate of value) {
      if (isHookDefinition(candidate)) {
        definitions.push(candidate)
      }
    }
    if (definitions.length > 0) {
      hooks[eventName] = definitions
    }
  }
  return hooks
}

export function stripInlineCodexHookSections(config: string): string {
  const lines = config.split('\n')
  const keptLines: string[] = []
  let droppingHookSection = false
  let scanState = createTomlLineScanState()

  for (const line of lines) {
    const header = isTomlStructuralLine(scanState) ? getTomlTableHeader(line) : null
    if (header) {
      droppingHookSection = isInlineCodexHookHeader(header)
    }
    if (!droppingHookSection) {
      keptLines.push(line)
    }
    scanState = updateTomlLineScanState(scanState, line)
  }
  const stripped = keptLines.join('\n')
  if (Object.keys(extractInlineCodexHooks(stripped)).length > 0) {
    throw new Error('unsupported inline Codex hook representation')
  }
  return stripped
}

function isHookDefinition(value: unknown): value is HookDefinition {
  if (!isPlainObject(value)) {
    return false
  }
  const handlers = value.hooks
  return (
    handlers === undefined ||
    (Array.isArray(handlers) &&
      handlers.every(
        (handler) =>
          isPlainObject(handler) &&
          handler.type === 'command' &&
          typeof handler.command === 'string'
      ))
  )
}

function isInlineCodexHookHeader(header: string): boolean {
  if (!header.trimStart().startsWith('[[')) {
    return false
  }
  try {
    const parsedHeader = parse(header)
    return (
      isPlainObject(parsedHeader.hooks) &&
      Object.keys(parsedHeader.hooks).some((key) => key !== 'state')
    )
  } catch {
    return false
  }
}
