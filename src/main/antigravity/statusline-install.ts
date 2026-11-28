import { rm } from 'node:fs/promises'
import { getAntigravityStatusLineScript } from './statusline-script'
import type { AntigravityStatusLineStatus } from '../../shared/agent-usage/rate-limits/antigravity-statusline-status'
import {
  fileExists,
  readRecord,
  readTextOrNull,
  resolvePaths,
  resolveSettingsTarget,
  sha256,
  writeRecord,
  writeScript,
  writeSettingsText,
  type AntigravityStatusLineOptions,
  type InstallRecord,
  type Paths
} from './statusline-install-files'
import {
  insertStatusLineMember,
  inspectStatusLine,
  removeStatusLineMember,
  replaceStatusLineCommand,
  type StatusLineEntry,
  type StatusLineInspection
} from './statusline-settings-edit'

export type { AntigravityStatusLineOptions } from './statusline-install-files'

const RECORD_MISSING = "Orca's restore record is missing; left unchanged"
const CONFLICT = 'Antigravity settings.json kept changing; left unchanged'
const INVALID = 'Could not parse Antigravity settings.json'

function status(
  paths: Paths,
  state: AntigravityStatusLineStatus['state'],
  detail: string | null = null
): AntigravityStatusLineStatus {
  return { state, configPath: paths.settings, detail }
}

const isEmptyObjectText = (text: string): boolean => /^\s*\{\s*\}\s*$/.test(text)

type Plan = { error: string } | { next: string; record: InstallRecord }

function planInstall(text: string | null, slot: StatusLineInspection, paths: Paths): Plan {
  if (slot.kind === 'invalid') {
    return { error: INVALID }
  }
  if (slot.kind === 'unsupported') {
    return { error: `${slot.detail}; left unchanged` }
  }
  const entry: StatusLineEntry = { type: 'command', command: paths.installedCommand }
  const base = { installedCommand: paths.installedCommand, preInstallText: text }
  if (text === null) {
    const next = `${JSON.stringify({ statusLine: entry }, null, 2)}\n`
    return { next, record: { ...base, originalCommand: null, postInstallSha256: sha256(next) } }
  }
  if (slot.kind === 'empty') {
    const next = insertStatusLineMember(text, entry)
    return next === null
      ? { error: INVALID }
      : { next, record: { ...base, originalCommand: null, postInstallSha256: sha256(next) } }
  }
  const edit = replaceStatusLineCommand(text, JSON.stringify(paths.installedCommand))
  return edit === null
    ? { error: INVALID }
    : {
        next: edit.text,
        record: {
          ...base,
          originalCommand: slot.command.trim() === '' ? null : slot.command,
          originalCommandLiteral: edit.previousLiteral,
          postInstallSha256: sha256(edit.text)
        }
      }
}

export async function getAntigravityStatusLineStatus(
  options: AntigravityStatusLineOptions = {}
): Promise<AntigravityStatusLineStatus> {
  const paths = resolvePaths(options)
  const resolved = await resolveSettingsTarget(paths.settings)
  const text = 'target' in resolved ? await readTextOrNull(resolved.target).catch(() => null) : null
  const slot = text === null ? null : inspectStatusLine(text)
  if (slot?.kind !== 'command' || slot.command !== paths.installedCommand) {
    return status(paths, 'not_installed')
  }
  const record = await readRecord(paths.record)
  if (record?.installedCommand !== paths.installedCommand) {
    return status(paths, 'error', RECORD_MISSING)
  }
  return (await fileExists(paths.script))
    ? status(paths, 'installed')
    : status(paths, 'error', 'The managed status-line script is missing')
}

export async function installAntigravityStatusLine(
  options: AntigravityStatusLineOptions = {}
): Promise<AntigravityStatusLineStatus> {
  const paths = resolvePaths(options)
  if (process.platform === 'win32') {
    return status(paths, 'error', 'Antigravity status-line usage is not supported on Windows')
  }
  const resolved = await resolveSettingsTarget(paths.settings)
  if ('error' in resolved) {
    return status(paths, 'error', resolved.error)
  }
  let text = await readTextOrNull(resolved.target)
  // One rebuild if agy or an editor saved while this ran; a second change gives up.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const slot = text === null ? ({ kind: 'empty' } as const) : inspectStatusLine(text)
    if (slot.kind === 'command' && slot.command === paths.installedCommand) {
      const record = await readRecord(paths.record)
      if (record?.installedCommand !== paths.installedCommand) {
        return status(paths, 'error', RECORD_MISSING)
      }
      await writeScript(paths.script, getAntigravityStatusLineScript(record.originalCommand))
      return status(paths, 'installed')
    }
    const plan = planInstall(text, slot, paths)
    if ('error' in plan) {
      return status(paths, 'error', plan.error)
    }
    // The record lands first so an interrupted install can always be undone.
    await writeRecord(paths.record, plan.record)
    await writeScript(paths.script, getAntigravityStatusLineScript(plan.record.originalCommand))
    const current = await readTextOrNull(resolved.target)
    if (current === text) {
      await writeSettingsText(resolved.target, plan.next)
      return status(paths, 'installed')
    }
    text = current
  }
  return status(paths, 'error', CONFLICT)
}

function planRemoval(text: string, record: InstallRecord): string | null {
  // An untouched post-install file goes back byte for byte, comments and odd spacing included.
  if (record.preInstallText !== null && sha256(text) === record.postInstallSha256) {
    return record.preInstallText
  }
  return record.originalCommandLiteral === undefined
    ? removeStatusLineMember(text)
    : (replaceStatusLineCommand(text, record.originalCommandLiteral)?.text ?? null)
}

export async function removeAntigravityStatusLine(
  options: AntigravityStatusLineOptions = {}
): Promise<AntigravityStatusLineStatus> {
  const paths = resolvePaths(options)
  const resolved = await resolveSettingsTarget(paths.settings)
  if ('error' in resolved) {
    return status(paths, 'error', resolved.error)
  }
  let text = await readTextOrNull(resolved.target)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const slot = text === null ? null : inspectStatusLine(text)
    if (slot?.kind === 'invalid') {
      return status(paths, 'error', INVALID)
    }
    if (text !== null && slot?.kind === 'command' && slot.command === paths.installedCommand) {
      const record = await readRecord(paths.record)
      if (record?.installedCommand !== paths.installedCommand) {
        return status(paths, 'error', RECORD_MISSING)
      }
      const next = planRemoval(text, record)
      if (next === null) {
        return status(paths, 'error', INVALID)
      }
      const current = await readTextOrNull(resolved.target)
      if (current !== text) {
        text = current
        continue
      }
      await (record.preInstallText === null && isEmptyObjectText(next)
        ? rm(resolved.target, { force: true })
        : writeSettingsText(resolved.target, next))
    }
    // The script stays: a running agy may still call it, and it only passes the user's command through.
    await rm(paths.record, { force: true })
    return status(paths, 'not_installed')
  }
  return status(paths, 'error', CONFLICT)
}
