import { describe, expect, it } from 'vitest'
import {
  isWindowsOrcadCellId,
  WINDOWS_CONVERT_CELL_ID,
  parseWindowsHostCellDescriptor,
  WINDOWS_FORBIDDEN_TOOLS,
  WINDOWS_HOST_CELL_IDS,
  windowsHostCell,
  windowsHostSshTarget
} from './ssh-windows-host-cells'

const DESCRIPTOR = {
  cell: 'pinned-powershell',
  target: 'win32-arm64',
  host: '127.0.0.1',
  port: 50022,
  username: 'orcaabc',
  identityFile: 'C:\\ossh\\client_key',
  home: 'C:/Users/orcaabc',
  forbiddenToolLog: 'C:\\ossh\\forbidden.log',
  receipt: 'C:\\receipts\\pinned-powershell.json'
}

describe('Windows SSH-host cells', () => {
  it('expects rung A for both DefaultShell cases and the ladder skipped when opted out', () => {
    const cells = WINDOWS_HOST_CELL_IDS.map((id) => windowsHostCell(id, 'win32-x64'))
    expect(
      cells.map(({ id, defaultShell, remoteRuntime }) => [id, defaultShell, remoteRuntime])
    ).toEqual([
      ['pinned-cmd', 'cmd', 'pinned-node'],
      ['pinned-powershell', 'powershell', 'pinned-node'],
      ['legacy-opt-out', 'cmd', 'legacy']
    ])
    expect(cells[0].expect).toEqual({ outcome: 'launched', rung: 'A', target: 'win32-x64' })
    expect(cells[2].expect).toEqual({ outcome: 'legacy_opt_out' })
  })

  it('shims the Windows compilers alongside the Linux toolchain list', () => {
    expect(WINDOWS_FORBIDDEN_TOOLS).toEqual(
      expect.arrayContaining(['npm', 'node-gyp', 'cl', 'clang'])
    )
    // Why never node: the lane proves host Node is absent from PATH, not merely logged.
    expect(WINDOWS_FORBIDDEN_TOOLS).not.toContain('node')
  })

  it('reads the descriptor PowerShell writes, BOM included', () => {
    const parsed = parseWindowsHostCellDescriptor(`\uFEFF${JSON.stringify(DESCRIPTOR)}`)
    expect(parsed).toEqual(DESCRIPTOR)
    if (isWindowsOrcadCellId(parsed.cell) || parsed.cell === WINDOWS_CONVERT_CELL_ID) {
      throw new Error(`expected a relay cell, got ${parsed.cell}`)
    }
    const target = windowsHostSshTarget(parsed, windowsHostCell(parsed.cell, parsed.target), 'r1')
    expect(target).toMatchObject({
      id: 'windows-host-pinned-powershell-r1',
      host: '127.0.0.1',
      port: 50022,
      username: 'orcaabc',
      identityFile: 'C:\\ossh\\client_key',
      identitiesOnly: true,
      remoteRuntime: 'pinned-node'
    })
  })

  it('rejects a descriptor that would drive the wrong host or cell', () => {
    const parse = (patch: Record<string, unknown>): unknown =>
      parseWindowsHostCellDescriptor(JSON.stringify({ ...DESCRIPTOR, ...patch }))
    expect(() => parse({ cell: 'pinned-bash' })).toThrow('Unknown Windows host cell')
    expect(
      parseWindowsHostCellDescriptor(JSON.stringify({ ...DESCRIPTOR, cell: 'orcad-cmd' })).cell
    ).toBe('orcad-cmd')
    expect(() => parse({ target: 'linux-x64-glibc' })).toThrow('win32-x64 or win32-arm64')
    expect(() => parse({ port: '22' })).toThrow('port is invalid')
    expect(() => parse({ port: 70_000 })).toThrow('port is invalid')
    expect(() => parse({ home: '' })).toThrow('non-empty string home')
    expect(() => parseWindowsHostCellDescriptor('[]')).toThrow('must be a JSON object')
  })
})
