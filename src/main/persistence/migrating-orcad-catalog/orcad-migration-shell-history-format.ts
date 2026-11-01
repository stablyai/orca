// The JSON header carries the unhashed worktree ID needed for history GC; raw history follows.
import { z } from 'zod'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { hashWorktreeId } from '../../terminal-history-id'

// fish history lives outside Orca's store and cannot migrate.
export const ORCAD_MIGRATION_SHELL_HISTORY_SHELLS = ['zsh', 'bash'] as const

export type OrcadMigrationShellHistoryShell = (typeof ORCAD_MIGRATION_SHELL_HISTORY_SHELLS)[number]

export const ORCAD_MIGRATION_SHELL_HISTORY_VERSION = 1
/** Bound header scanning; worktree IDs contain a repo ID and path. */
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
  /** WSL bridge history uses bash_history for the distro login shell when no zsh sibling exists. */
  loginShell: boolean
  byteLength: number
}

export function orcadMigrationShellHistoryKey(
  worktreeId: string,
  shell: OrcadMigrationShellHistoryShell
): string {
  return `${hashWorktreeId(worktreeId)}-${shell}`
}

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

/** Verify the header matches the hashed key; totalBytes includes the header and must leave history bytes. */
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
