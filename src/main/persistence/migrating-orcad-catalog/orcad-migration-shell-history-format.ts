/**
 * The `shell-history` migration blob: one worktree's history file for one shell, keyed
 * `<hashWorktreeId(destination worktree id)>-<shell>`. The bytes are a one-line JSON header naming
 * that worktree id, then the history file verbatim. The header is there because a key's hash
 * cannot be reversed, the destination's meta.json needs the id (history GC prunes by it), and the
 * catalog does not list every git worktree a terminal ever ran in.
 */
import { z } from 'zod'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/orcad-migration-blob-transfer'
import { hashWorktreeId } from '../../terminal-history-id'

/** fish keeps its history in the distro's own fish data dir, not Orca's store, so it never moves. */
export const ORCAD_MIGRATION_SHELL_HISTORY_SHELLS = ['zsh', 'bash'] as const

export type OrcadMigrationShellHistoryShell = (typeof ORCAD_MIGRATION_SHELL_HISTORY_SHELLS)[number]

export const ORCAD_MIGRATION_SHELL_HISTORY_VERSION = 1
/** Bounds the scan for the header's newline; a worktree id is a repo id plus one path. */
export const ORCAD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES = 16 * 1024
const NEWLINE = 0x0a

const HeaderSchema = z.object({
  version: z.literal(ORCAD_MIGRATION_SHELL_HISTORY_VERSION),
  worktreeId: z.string().min(1),
  loginShell: z.literal(true).optional()
})

export const MAX_ORCAD_MIGRATION_SHELL_HISTORY_BYTES =
  ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].maxBytes

export type OrcadMigrationShellHistoryKey = {
  worktreeHash: string
  shell: OrcadMigrationShellHistoryShell
}

export type OrcadMigrationShellHistoryHeader = {
  worktreeId: string
  /**
   * The desktop's WSL bridge names every pane's history `bash_history`, but wsl.exe runs the
   * distro's login shell, so the file holds that shell's history; set only on such a bash file
   * that has no zsh sibling.
   */
  loginShell: boolean
  /** Where the history bytes start. */
  byteLength: number
}

export function orcadMigrationShellHistoryKey(
  worktreeId: string,
  shell: OrcadMigrationShellHistoryShell
): string {
  return `${hashWorktreeId(worktreeId)}-${shell}`
}

/** The history file a shell keeps in a worktree's history directory (see terminal-history.ts). */
export function shellHistoryFileName(shell: OrcadMigrationShellHistoryShell): string {
  return `${shell}_history`
}

export function parseOrcadMigrationShellHistoryKey(key: string): OrcadMigrationShellHistoryKey {
  if (!ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].key.test(key)) {
    throw new Error('orcad_migration_shell_history_key_invalid')
  }
  const [worktreeHash, shell] = key.split('-')
  const supported = ORCAD_MIGRATION_SHELL_HISTORY_SHELLS.find((entry) => entry === shell)
  if (!supported) {
    throw new Error('orcad_migration_shell_history_shell_unsupported')
  }
  return { worktreeHash, shell: supported }
}

export function encodeOrcadMigrationShellHistoryHeader(
  worktreeId: string,
  options: { loginShell?: boolean } = {}
): Buffer {
  const document = {
    version: ORCAD_MIGRATION_SHELL_HISTORY_VERSION,
    worktreeId,
    ...(options.loginShell ? { loginShell: true } : {})
  }
  const header = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8')
  if (header.length > ORCAD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES) {
    throw new Error('orcad_migration_shell_history_worktree_id_too_long')
  }
  return header
}

/**
 * Reads only the header from the first bytes of a blob and checks it names the worktree the key
 * hashes. `totalBytes` is the whole blob's size, so an empty history is refused without a read.
 */
export function parseOrcadMigrationShellHistoryHeader(
  key: string,
  head: Buffer,
  totalBytes: number
): OrcadMigrationShellHistoryHeader {
  const parsedKey = parseOrcadMigrationShellHistoryKey(key)
  const end = head.subarray(0, ORCAD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES).indexOf(NEWLINE)
  if (end === -1) {
    throw new Error('orcad_migration_shell_history_header_invalid')
  }
  const { worktreeId, loginShell } = parseHeaderLine(head.subarray(0, end))
  if (hashWorktreeId(worktreeId) !== parsedKey.worktreeHash) {
    throw new Error('orcad_migration_shell_history_key_mismatch')
  }
  const byteLength = end + 1
  if (totalBytes <= byteLength) {
    throw new Error('orcad_migration_shell_history_empty')
  }
  return { worktreeId, loginShell, byteLength }
}

function parseHeaderLine(line: Buffer): { worktreeId: string; loginShell: boolean } {
  try {
    const parsed = HeaderSchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
    )
    if (parsed.success) {
      return { worktreeId: parsed.data.worktreeId, loginShell: parsed.data.loginShell === true }
    }
  } catch {
    // Not UTF-8 JSON; refused below like any other malformed header.
  }
  throw new Error('orcad_migration_shell_history_header_invalid')
}
