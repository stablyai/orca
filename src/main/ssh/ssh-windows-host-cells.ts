/**
 * Windows SSH-host lanes for the pinned relay (design D5/D6 exit gate): a real Win32-OpenSSH
 * server on 127.0.0.1, provisioned by config/ci/windows-ssh-provider/, driven through the same
 * harness as the Docker hostile-host matrix. `.github/workflows/ssh-windows-hosts.yml` runs it.
 */
import { readFileSync } from 'node:fs'
import { isWindowsServerTarget, type WindowsServerTarget } from '../../shared/node-runtime-pin'
import type { SshRemoteRuntime, SshTarget } from '../../shared/ssh-types'
import { FORBIDDEN_TOOLS, type HostileHostCellCore } from './ssh-hostile-host-cells'

/** `cmd` is stock sshd (no DefaultShell value); `powershell` sets DefaultShell to Windows PowerShell. */
export const WINDOWS_SSH_DEFAULT_SHELLS = ['cmd', 'powershell'] as const
export type WindowsSshDefaultShell = (typeof WINDOWS_SSH_DEFAULT_SHELLS)[number]

/** Shimmed on the SSH-side PATH as logging `.cmd` files; the Linux list plus MSVC and LLVM. */
export const WINDOWS_FORBIDDEN_TOOLS = [
  ...FORBIDDEN_TOOLS,
  'cl',
  'clang',
  'clang++',
  'msbuild',
  'cmake'
] as const

export type WindowsHostCell = HostileHostCellCore & {
  defaultShell: WindowsSshDefaultShell
  remoteRuntime: SshRemoteRuntime
}

export const WINDOWS_HOST_CELL_IDS = ['pinned-cmd', 'pinned-powershell', 'legacy-opt-out'] as const
export type WindowsHostCellId = (typeof WINDOWS_HOST_CELL_IDS)[number]

export function isWindowsHostCellId(id: string): id is WindowsHostCellId {
  return WINDOWS_HOST_CELL_IDS.some((candidate) => candidate === id)
}

export function windowsHostCell(
  id: WindowsHostCellId,
  target: WindowsServerTarget
): WindowsHostCell {
  const launched = { outcome: 'launched', rung: 'A', target } as const
  switch (id) {
    case 'pinned-cmd':
      return {
        id,
        defaultShell: 'cmd',
        remoteRuntime: 'pinned-node',
        expect: launched
      }
    case 'pinned-powershell':
      return {
        id,
        defaultShell: 'powershell',
        remoteRuntime: 'pinned-node',
        expect: launched
      }
    case 'legacy-opt-out':
      return {
        id,
        defaultShell: 'cmd',
        remoteRuntime: 'legacy',
        expect: { outcome: 'legacy_opt_out' }
      }
  }
}

/** Managed orcad on the pinned node.exe, per DefaultShell: deploy, readiness, stop request, exit. */
export const WINDOWS_ORCAD_CELL_IDS = ['orcad-cmd', 'orcad-powershell'] as const
export type WindowsOrcadCellId = (typeof WINDOWS_ORCAD_CELL_IDS)[number]

export function isWindowsOrcadCellId(id: string): id is WindowsOrcadCellId {
  return WINDOWS_ORCAD_CELL_IDS.some((candidate) => candidate === id)
}

/** The app connects a relay-era host and converts it to managed orcad (tests/e2e). */
export const WINDOWS_CONVERT_CELL_ID = 'orcad-convert'

/** The bundled CLI against a managed host (tests/e2e/ssh-orcad-windows-cli-matrix.spec.ts). */
export const WINDOWS_CLI_MATRIX_CELL_IDS = [
  'orcad-cli-managed',
  'orcad-cli-convert',
  'orcad-cli-relay-kept'
] as const
export type WindowsCliMatrixCellId = (typeof WINDOWS_CLI_MATRIX_CELL_IDS)[number]

/** Written by config/ci/windows-ssh-provider/invoke-pinned-relay-cells.ps1, one per run. */
export type WindowsHostCellDescriptor = {
  cell:
    | WindowsHostCellId
    | WindowsOrcadCellId
    | typeof WINDOWS_CONVERT_CELL_ID
    | WindowsCliMatrixCellId
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
  const parsed: unknown = JSON.parse(text.replace(/^﻿/u, ''))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Windows host cell descriptor must be a JSON object')
  }
  const record = Object.fromEntries(Object.entries(parsed))
  const cell =
    WINDOWS_HOST_CELL_IDS.find((id) => id === record.cell) ??
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
  cell: Pick<WindowsHostCell, 'id' | 'remoteRuntime'>,
  runId: string
): SshTarget {
  return {
    id: `windows-host-${cell.id}-${runId}`,
    label: `Windows host ${cell.id}`,
    source: 'manual',
    host: descriptor.host,
    port: descriptor.port,
    username: descriptor.username,
    identityFile: descriptor.identityFile,
    identitiesOnly: true,
    remoteRuntime: cell.remoteRuntime
  }
}
