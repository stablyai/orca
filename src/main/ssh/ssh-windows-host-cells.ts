/** Real Win32-OpenSSH cells provisioned by config/ci/windows-ssh-provider/ and run by ssh-windows-hosts.yml. */
import { readFileSync } from 'node:fs'
import { isWindowsServerTarget, type WindowsServerTarget } from '../../shared/node-runtime-pin'
import type { SshTarget } from '../../shared/ssh-types'

/** Pinned node.exe lifecycle under each DefaultShell. */
const WINDOWS_ORCAD_CELL_IDS = ['orcad-cmd', 'orcad-powershell'] as const
type WindowsOrcadCellId = (typeof WINDOWS_ORCAD_CELL_IDS)[number]

export function isWindowsOrcadCellId(id: string): id is WindowsOrcadCellId {
  return WINDOWS_ORCAD_CELL_IDS.some((candidate) => candidate === id)
}

/** Relay-to-managed conversion through the app (tests/e2e). */
const WINDOWS_CONVERT_CELL_ID = 'orcad-convert'

/** Bundled CLI cells: tests/e2e/ssh-orcad-windows-cli-matrix.spec.ts. */
const WINDOWS_CLI_MATRIX_CELL_IDS = ['orcad-cli-managed', 'orcad-cli-convert'] as const
type WindowsCliMatrixCellId = (typeof WINDOWS_CLI_MATRIX_CELL_IDS)[number]

/** Written by config/ci/windows-ssh-provider/invoke-windows-host-cells.ps1, one per run. */
type WindowsHostCellDescriptor = {
  cell: WindowsOrcadCellId | typeof WINDOWS_CONVERT_CELL_ID | WindowsCliMatrixCellId
  target: WindowsServerTarget
  host: string
  port: number
  username: string
  identityFile: string
  /** The account's profile directory, observed on the host after its first logon. */
  home: string
  forbiddenToolLog: string
  receipt: string
}

function field(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Windows host cell descriptor needs a non-empty string ${key}`)
  }
  return value
}

export function parseWindowsHostCellDescriptor(text: string): WindowsHostCellDescriptor {
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/u, ''))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Windows host cell descriptor must be a JSON object')
  }
  const record = Object.fromEntries(Object.entries(parsed))
  const cell =
    WINDOWS_ORCAD_CELL_IDS.find((id) => id === record.cell) ??
    WINDOWS_CLI_MATRIX_CELL_IDS.find((id) => id === record.cell) ??
    (record.cell === WINDOWS_CONVERT_CELL_ID ? WINDOWS_CONVERT_CELL_ID : undefined)
  if (!cell) {
    throw new Error(`Unknown Windows host cell: ${String(record.cell)}`)
  }
  const target = field(record, 'target')
  if (!isWindowsServerTarget(target)) {
    throw new Error(`Windows host cell target must be win32-x64 or win32-arm64, got ${target}`)
  }
  const { port } = record
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Windows host cell port is invalid: ${String(port)}`)
  }
  return {
    cell,
    target,
    host: field(record, 'host'),
    port,
    username: field(record, 'username'),
    identityFile: field(record, 'identityFile'),
    home: field(record, 'home'),
    forbiddenToolLog: field(record, 'forbiddenToolLog'),
    receipt: field(record, 'receipt')
  }
}

export function readWindowsHostCellDescriptor(path: string): WindowsHostCellDescriptor {
  return parseWindowsHostCellDescriptor(readFileSync(path, 'utf8'))
}

export function windowsHostSshTarget(
  descriptor: WindowsHostCellDescriptor,
  runId: string
): SshTarget {
  return {
    id: `windows-host-${descriptor.cell}-${runId}`,
    label: `Windows host ${descriptor.cell}`,
    source: 'manual',
    host: descriptor.host,
    port: descriptor.port,
    username: descriptor.username,
    identityFile: descriptor.identityFile,
    identitiesOnly: true,
    remoteRuntime: 'pinned-node'
  }
}
