import { existsSync } from 'node:fs'
import { readAgentStateFileSync } from '../agent-state-file-reader'
import { parseTomlTableHeaderPath } from './config-toml-key-path'
import { getTomlSections } from './config-toml-runtime-owned-sections'
import type { CodexSettingsBaseline, CodexSettingsConflict } from './config-settings-baseline'
import { resolveUntrackedCodexSetting } from './config-settings-conflict-resolution'

const REGISTRATION_ROOTS = new Set(['marketplaces', 'plugins'])

export function readCodexPluginRegistrationTables(configPath: string): Map<string, string> {
  if (!existsSync(configPath)) {
    return new Map()
  }
  const content = readAgentStateFileSync(configPath)
  const lines = content.split('\n')
  const registrations = new Map<string, string>()
  for (const table of getTomlTableRanges(content)) {
    const key = getCodexPluginRegistrationKey(table.header)
    if (key && !registrations.has(key)) {
      registrations.set(
        key,
        normalizeRegistrationBlock(lines.slice(table.start, table.end).join('\n'))
      )
    }
  }
  return registrations
}

export function isCodexPluginRegistrationKey(key: string): boolean {
  const separator = key.indexOf('.')
  if (!REGISTRATION_ROOTS.has(key.slice(0, separator))) {
    return false
  }
  try {
    return typeof JSON.parse(key.slice(separator + 1)) === 'string'
  } catch {
    return false
  }
}

export function applyCodexPluginRegistrationChanges(
  content: string,
  changes: ReadonlyMap<string, string | null>
): string {
  let result = content
  for (const [key, block] of changes) {
    if (isCodexPluginRegistrationKey(key)) {
      result = applyCodexPluginRegistrationChange(result, key, block)
    }
  }
  return result
}

export function collectCodexPluginRegistrationChanges(context: {
  baseline: CodexSettingsBaseline
  runtimeRegistrations: ReadonlyMap<string, string>
  systemRegistrations: ReadonlyMap<string, string>
  registrationChanges: Map<string, string | null>
  conflicts: Map<string, CodexSettingsConflict>
  runtimeValuesToPreserve: Map<string, string | null>
}): void {
  const keys = new Set([
    ...context.runtimeRegistrations.keys(),
    ...context.systemRegistrations.keys(),
    ...(context.baseline.pluginRegistrations?.keys() ?? []),
    ...[...context.baseline.conflicts.keys()].filter(isCodexPluginRegistrationKey)
  ])
  for (const key of keys) {
    const runtimeRaw = context.runtimeRegistrations.get(key) ?? null
    const systemRaw = context.systemRegistrations.get(key) ?? null
    const existingConflict = context.baseline.conflicts.get(key)
    if (existingConflict || context.baseline.pluginRegistrations === null) {
      const resolution = resolveUntrackedCodexSetting(runtimeRaw, systemRaw, existingConflict)
      if (resolution.action === 'promote-runtime') {
        context.registrationChanges.set(key, resolution.raw)
      } else if (resolution.action === 'preserve') {
        context.conflicts.set(key, resolution.conflict)
        context.runtimeValuesToPreserve.set(key, runtimeRaw)
      }
      continue
    }

    const baselineRaw = context.baseline.pluginRegistrations.get(key) ?? null
    if (runtimeRaw !== baselineRaw && systemRaw === baselineRaw) {
      context.registrationChanges.set(key, runtimeRaw)
    }
  }
}

function getCodexPluginRegistrationKey(header: string): string | null {
  const table = parseTomlTableHeaderPath(header)
  if (
    !table ||
    table.isArray ||
    table.segments.length !== 2 ||
    !REGISTRATION_ROOTS.has(table.segments[0] ?? '')
  ) {
    return null
  }
  return `${table.segments[0]}.${JSON.stringify(table.segments[1])}`
}

function applyCodexPluginRegistrationChange(
  content: string,
  key: string,
  block: string | null
): string {
  const lines = content.split('\n')
  const matches = getTomlTableRanges(content).filter(
    (table) => getCodexPluginRegistrationKey(table.header) === key
  )

  if (matches.length === 0) {
    return block === null ? content : appendRegistrationBlock(content, block)
  }

  const firstStart = matches[0]?.start
  for (const match of matches.toReversed()) {
    if (block !== null && match.start === firstStart) {
      let suffixStart = match.end
      while (suffixStart > match.start + 1 && (lines[suffixStart - 1] ?? '').trim() === '') {
        suffixStart -= 1
      }
      lines.splice(
        match.start,
        match.end - match.start,
        ...renderRegistrationLines(block, content.includes('\r\n')),
        ...lines.slice(suffixStart, match.end)
      )
    } else {
      lines.splice(match.start, match.end - match.start)
    }
  }
  return lines.join('\n')
}

function getTomlTableRanges(content: string): { header: string; start: number; end: number }[] {
  const lines = content.split('\n')
  const sections = getTomlSections(content)
  const starts = sections.map((section) => {
    let start = section.start
    while (start > 0) {
      const previous = (lines[start - 1] ?? '').trim()
      if (previous !== '' && !previous.startsWith('#')) {
        break
      }
      start -= 1
    }
    return start
  })
  return sections.map((section, index) => ({
    header: section.header,
    start: starts[index] ?? section.start,
    end: starts[index + 1] ?? lines.length
  }))
}

function appendRegistrationBlock(content: string, block: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const rendered = normalizeRegistrationBlock(block).replace(/\n/g, eol)
  if (content.length === 0) {
    return `${rendered}${eol}`
  }
  const separator = content.endsWith(`${eol}${eol}`)
    ? ''
    : content.endsWith(eol)
      ? eol
      : `${eol}${eol}`
  return `${content}${separator}${rendered}${eol}`
}

function renderRegistrationLines(block: string, usesCrlf: boolean): string[] {
  return normalizeRegistrationBlock(block)
    .split('\n')
    .map((line) => (usesCrlf ? `${line}\r` : line))
}

function normalizeRegistrationBlock(block: string): string {
  const lines = block.replace(/\r\n/g, '\n').split('\n')
  while (lines[0]?.trim() === '') {
    lines.shift()
  }
  while (lines.at(-1)?.trim() === '') {
    lines.pop()
  }
  return lines.join('\n')
}
