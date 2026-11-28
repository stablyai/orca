import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { quotePosixShellUnlessPlain } from '../../shared/shell/launch/shell-argument-quoting'
import { writePluginFileAtomically } from '../plugins/installation/plugin-atomic-file-write'
import { getAntigravityStatusLineScript } from './statusline-script'
import {
  insertStatusLineMember,
  removeStatusLineMember,
  replaceStatusLineCommand
} from './statusline-settings-edit'

const SCRIPT_FILE_NAME = 'antigravity-statusline.sh'
const RECORD_FILE_NAME = 'antigravity-statusline.json'

export type AntigravityStatusLineStatus = {
  state: 'installed' | 'not_installed' | 'error'
  configPath: string
  detail: string | null
}

export type AntigravityStatusLineOptions = { homeDir?: string }

// Restoring needs what the slot held before Orca claimed it.
type InstallRecord = {
  originalCommand: string | null
  /** The command as the file spelled it, so a restore keeps its escapes. */
  originalCommandLiteral?: string
  installedCommand: string
  createdSettingsFile: boolean
}

type Slot = { kind: 'empty' } | { kind: 'command'; command: string } | { kind: 'unsupported' }

type Settings =
  | { kind: 'absent' }
  | { kind: 'ok'; text: string; slot: Slot; mode: number }
  | { kind: 'error'; detail: string }

type Paths = { settings: string; script: string; record: string; installedCommand: string }

function resolvePaths(options: AntigravityStatusLineOptions): Paths {
  const home = options.homeDir ?? homedir()
  const script = join(home, '.orca', 'agent-hooks', SCRIPT_FILE_NAME)
  return {
    settings: join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    script,
    record: join(home, '.orca', 'agent-hooks', RECORD_FILE_NAME),
    installedCommand: quotePosixShellUnlessPlain(script)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSlot(root: Record<string, unknown>): Slot {
  if (!('statusLine' in root)) {
    return { kind: 'empty' }
  }
  const { statusLine } = root
  if (
    isPlainObject(statusLine) &&
    statusLine.type === 'command' &&
    typeof statusLine.command === 'string' &&
    statusLine.command.trim() !== ''
  ) {
    return { kind: 'command', command: statusLine.command }
  }
  return { kind: 'unsupported' }
}

async function readSettings(path: string): Promise<Settings> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' }
    }
    return { kind: 'error', detail: 'Could not read Antigravity settings.json' }
  }
  const errors: ParseError[] = []
  const root: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isPlainObject(root)) {
    return { kind: 'error', detail: 'Could not parse Antigravity settings.json' }
  }
  const mode = (await stat(path)).mode & 0o777
  return { kind: 'ok', text, slot: readSlot(root), mode }
}

async function readRecord(path: string): Promise<InstallRecord | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      isPlainObject(raw) &&
      typeof raw.installedCommand === 'string' &&
      (raw.originalCommand === null || typeof raw.originalCommand === 'string')
    ) {
      return {
        originalCommand: raw.originalCommand,
        ...(typeof raw.originalCommandLiteral === 'string'
          ? { originalCommandLiteral: raw.originalCommandLiteral }
          : {}),
        installedCommand: raw.installedCommand,
        createdSettingsFile: raw.createdSettingsFile === true
      }
    }
  } catch {
    // A missing or damaged record means no restore point.
  }
  return null
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

function status(
  paths: Paths,
  state: AntigravityStatusLineStatus['state'],
  detail: string | null = null
): AntigravityStatusLineStatus {
  return { state, configPath: paths.settings, detail }
}

function unsupportedPlatform(): boolean {
  return process.platform === 'win32'
}

export async function getAntigravityStatusLineStatus(
  options: AntigravityStatusLineOptions = {}
): Promise<AntigravityStatusLineStatus> {
  const paths = resolvePaths(options)
  const settings = await readSettings(paths.settings)
  if (settings.kind === 'error') {
    return status(paths, 'error', settings.detail)
  }
  if (
    settings.kind === 'ok' &&
    settings.slot.kind === 'command' &&
    settings.slot.command === paths.installedCommand
  ) {
    return (await fileExists(paths.script))
      ? status(paths, 'installed')
      : status(paths, 'error', 'The managed status-line script is missing')
  }
  return status(paths, 'not_installed')
}

export async function installAntigravityStatusLine(
  options: AntigravityStatusLineOptions = {}
): Promise<AntigravityStatusLineStatus> {
  const paths = resolvePaths(options)
  if (unsupportedPlatform()) {
    return status(paths, 'error', 'Antigravity status-line usage is not supported on Windows')
  }
  const settings = await readSettings(paths.settings)
  if (settings.kind === 'error') {
    return status(paths, 'error', settings.detail)
  }
  const slot: Slot = settings.kind === 'ok' ? settings.slot : { kind: 'empty' }
  if (slot.kind === 'unsupported') {
    return status(paths, 'error', 'Antigravity statusLine is not a command; left unchanged')
  }
  const alreadyManaged = slot.kind === 'command' && slot.command === paths.installedCommand
  const entry = { type: 'command', command: paths.installedCommand }
  let nextSettings = `${JSON.stringify({ statusLine: entry }, null, 2)}\n`
  let record: InstallRecord = {
    originalCommand: slot.kind === 'command' ? slot.command : null,
    installedCommand: paths.installedCommand,
    createdSettingsFile: settings.kind === 'absent'
  }
  if (alreadyManaged) {
    const previous = await readRecord(paths.record)
    record = { ...record, ...previous, originalCommand: previous?.originalCommand ?? null }
  } else if (settings.kind === 'ok') {
    const edit =
      slot.kind === 'command'
        ? replaceStatusLineCommand(settings.text, JSON.stringify(paths.installedCommand))
        : null
    const next = edit?.text ?? insertStatusLineMember(settings.text, entry)
    if (next === null) {
      return status(paths, 'error', 'Could not edit Antigravity settings.json; left unchanged')
    }
    nextSettings = next
    if (edit) {
      record = { ...record, originalCommandLiteral: edit.previousLiteral }
    }
  }
  await mkdir(dirname(paths.script), { recursive: true })
  await writePluginFileAtomically(
    paths.script,
    getAntigravityStatusLineScript(record.originalCommand),
    { mode: 0o755 }
  )
  await writePluginFileAtomically(paths.record, `${JSON.stringify(record, null, 2)}\n`)
  if (!alreadyManaged) {
    await mkdir(dirname(paths.settings), { recursive: true })
    await writePluginFileAtomically(paths.settings, nextSettings, {
      mode: settings.kind === 'ok' ? settings.mode : undefined
    })
  }
  return status(paths, 'installed')
}

export async function removeAntigravityStatusLine(
  options: AntigravityStatusLineOptions = {}
): Promise<AntigravityStatusLineStatus> {
  const paths = resolvePaths(options)
  const settings = await readSettings(paths.settings)
  if (settings.kind === 'error') {
    return status(paths, 'error', settings.detail)
  }
  if (
    settings.kind === 'ok' &&
    settings.slot.kind === 'command' &&
    settings.slot.command === paths.installedCommand
  ) {
    const record = await readRecord(paths.record)
    if (record === null) {
      return status(paths, 'error', 'No record of the original status line; left unchanged')
    }
    const next =
      record.originalCommand === null
        ? removeStatusLineMember(settings.text)
        : replaceStatusLineCommand(
            settings.text,
            record.originalCommandLiteral ?? JSON.stringify(record.originalCommand)
          )?.text
    if (next === null || next === undefined) {
      return status(paths, 'error', 'Could not edit Antigravity settings.json; left unchanged')
    }
    await (record.createdSettingsFile && isEmptyObject(next)
      ? rm(paths.settings, { force: true })
      : writePluginFileAtomically(paths.settings, next, { mode: settings.mode }))
  }
  // A changed command no longer points at the script, so only Orca's own files go.
  await rm(paths.script, { force: true })
  await rm(paths.record, { force: true })
  return status(paths, 'not_installed')
}

function isEmptyObject(text: string): boolean {
  const root: unknown = parse(text)
  return isPlainObject(root) && Object.keys(root).length === 0
}
