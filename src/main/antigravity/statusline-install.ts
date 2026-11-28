import { readFile, rm } from 'node:fs/promises'
import { getAntigravityStatusLineScript } from './statusline-script'
import type { AntigravityStatusLineStatus } from '../../shared/agent-usage/rate-limits/antigravity-statusline-status'
import {
  commitSettingsText,
  fileExists,
  readRecord,
  readTextOrNull,
  resolvePaths,
  resolveSettingsTarget,
  restoreFileText,
  sha256,
  writeRecord,
  writeScript,
  type AntigravityStatusLineOptions,
  type InstallRecord,
  type Paths
} from './statusline-install-files'
import {
  hasJsonComments,
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
const COMMENTS = "Antigravity settings.json has comments; Orca won't edit it"
const TURNED_OFF = "agy's status line is turned off; left unchanged"

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
  if (text !== null && hasJsonComments(text)) {
    return { error: COMMENTS }
  }
  if (slot.kind === 'command' && slot.disabled) {
    return { error: TURNED_OFF }
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
  const text =
    'target' in resolved ? await readTextOrNull(resolved.target).catch(() => undefined) : undefined
  const record = await readRecord(paths.record)
  const slot = typeof text === 'string' ? inspectStatusLine(text) : null
  if (text === undefined || slot?.kind === 'invalid') {
    // A record with unreadable settings may hold a command Orca still has to undo.
    return (await fileExists(paths.record))
      ? status(paths, 'error', INVALID)
      : status(paths, 'not_installed')
  }
  if (slot?.kind !== 'command' || slot.command !== paths.installedCommand) {
    return status(paths, 'not_installed')
  }
  if (record?.installedCommand !== paths.installedCommand) {
    return status(paths, 'error', RECORD_MISSING)
  }
  return (await fileExists(paths.script))
    ? status(paths, 'installed')
    : status(paths, 'error', 'The managed status-line script is missing')
}

async function readRawOrNull(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
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
  const before = {
    record: await readRawOrNull(paths.record),
    script: await readRawOrNull(paths.script)
  }
  let wrote = false
  let done = false
  try {
    // One rebuild if agy or an editor saved while this ran; a second change gives up.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const slot = text === null ? ({ kind: 'empty' } as const) : inspectStatusLine(text)
      if (slot.kind === 'command' && slot.command === paths.installedCommand) {
        const record = await readRecord(paths.record)
        if (record?.installedCommand !== paths.installedCommand) {
          return status(paths, 'error', RECORD_MISSING)
        }
        await writeScript(paths.script, getAntigravityStatusLineScript(record.originalCommand))
        done = true
        return status(paths, 'installed')
      }
      const plan = planInstall(text, slot, paths)
      if ('error' in plan) {
        return status(paths, 'error', plan.error)
      }
      // The record lands first so an interrupted install can always be undone.
      wrote = true
      await writeRecord(paths.record, plan.record)
      await writeScript(paths.script, getAntigravityStatusLineScript(plan.record.originalCommand))
      if (await commitSettingsText(resolved.target, text, plan.next)) {
        done = true
        return status(paths, 'installed')
      }
      text = await readTextOrNull(resolved.target)
    }
    return status(paths, 'error', CONFLICT)
  } finally {
    // An install that did not land leaves the record and script as they were.
    if (wrote && !done) {
      await restoreFileText(paths.record, before.record, 0o600).catch(() => undefined)
      await restoreFileText(paths.script, before.script, 0o700).catch(() => undefined)
    }
  }
}

type RemovalPlan = { next: string } | { error: string }

function planRemoval(text: string, record: InstallRecord): RemovalPlan {
  // An untouched post-install file goes back byte for byte, comments and odd spacing included.
  if (record.preInstallText !== null && sha256(text) === record.postInstallSha256) {
    return { next: record.preInstallText }
  }
  if (hasJsonComments(text)) {
    return { error: COMMENTS }
  }
  const next =
    record.originalCommandLiteral === undefined
      ? removeStatusLineMember(text)
      : (replaceStatusLineCommand(text, record.originalCommandLiteral)?.text ?? null)
  return next === null ? { error: INVALID } : { next }
}

export async function removeAntigravityStatusLine(
  options: AntigravityStatusLineOptions = {}
): Promise<AntigravityStatusLineStatus> {
  const paths = resolvePaths(options)
  const resolved = await resolveSettingsTarget(paths.settings)
  if ('error' in resolved) {
    return status(paths, 'error', resolved.error)
  }
  const record = await readRecord(paths.record)
  let text = await readTextOrNull(resolved.target)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const slot = text === null ? null : inspectStatusLine(text)
    if (slot?.kind === 'invalid') {
      return status(paths, 'error', INVALID)
    }
    // Ownership is the command alone: agy's own `enabled` switch does not change who owns it.
    if (text !== null && slot?.kind === 'command' && slot.command === paths.installedCommand) {
      if (record?.installedCommand !== paths.installedCommand) {
        return status(paths, 'error', RECORD_MISSING)
      }
      const plan = planRemoval(text, record)
      if ('error' in plan) {
        return status(paths, 'error', plan.error)
      }
      const created = record.preInstallText === null && isEmptyObjectText(plan.next)
      if (!(await commitSettingsText(resolved.target, text, created ? null : plan.next))) {
        text = await readTextOrNull(resolved.target)
        continue
      }
    }
    // The script stays for a running agy, but stops posting once the feature is off.
    if (record && (await fileExists(paths.script))) {
      await writeScript(
        paths.script,
        getAntigravityStatusLineScript(record.originalCommand, { forwardQuota: false })
      )
    }
    await rm(paths.record, { force: true })
    return status(paths, 'not_installed')
  }
  return status(paths, 'error', CONFLICT)
}
