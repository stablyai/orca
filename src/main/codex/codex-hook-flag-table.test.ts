import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fromMsysPath,
  publishCodexHookFlagEntry,
  readCodexHookFlagEntry,
  removeCodexHookFlagTable,
  resolveCodexProbePath,
  takeCodexHookFlagRequests
} from './codex-hook-flag-table'

const canDenyWrites = process.platform !== 'win32' && process.getuid?.() !== 0

describe('Codex hook flag table files', () => {
  let root: string
  let table: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-table-'))
    table = join(root, 'codex-hook-flags')
    mkdirSync(table)
  })

  afterEach(() => {
    chmodSync(table, 0o755)
    rmSync(root, { recursive: true, force: true })
  })

  it('reads a request PowerShell 5.1 wrote with a byte-order mark', () => {
    writeFileSync(join(table, 'codex-cli 0.159.2.request'), '\uFEFFC:\\npm\\codex.ps1\r\n')

    expect(takeCodexHookFlagRequests(table)).toEqual([
      { codexVersion: 'codex-cli 0.159.2', codexPath: 'C:\\npm\\codex.ps1' }
    ])
  })

  it('drops requests whose name no carrier could have written, and anything not a file', () => {
    writeFileSync(join(table, 'not a version!.request'), '/x/codex\n')
    mkdirSync(join(table, 'codex-cli 9.9.9.request'))

    expect(takeCodexHookFlagRequests(table)).toEqual([])
    expect(readdirSync(table)).toEqual(['codex-cli 9.9.9.request'])
  })

  it.skipIf(!canDenyWrites)('logs instead of throwing when the table cannot be removed', () => {
    writeFileSync(join(table, 'codex-cli 0.159.2.request'), '')
    chmodSync(table, 0o555)

    expect(removeCodexHookFlagTable(table)).toBe(false)
    expect(existsSync(table)).toBe(true)
  })

  it('leaves no temp file behind when a publish cannot finish', () => {
    // Why a directory at the entry's path: the rename over it fails.
    mkdirSync(join(table, 'codex-cli 0.159.2.flag'))

    expect(() =>
      publishCodexHookFlagEntry(
        { codexVersion: 'codex-cli 0.159.2', flag: 'hooks={}', noDaemon: false },
        table
      )
    ).toThrow()
    expect(readdirSync(table).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(readCodexHookFlagEntry('codex-cli 0.159.2', table)).toBeNull()
  })

  it("reads a Git Bash pane's codex path as Windows spells it, on Windows only", () => {
    expect(fromMsysPath('/c/Users/me/AppData/Roaming/npm/codex', 'win32')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex'
    )
    expect(fromMsysPath('/d', 'win32')).toBe('D:\\')
    expect(fromMsysPath('C:\\npm\\codex.cmd', 'win32')).toBe('C:\\npm\\codex.cmd')
    expect(fromMsysPath('/c/Users/me/codex', 'darwin')).toBe('/c/Users/me/codex')
  })

  it("maps npm's PowerShell shim to its sibling codex.cmd, which can be spawned", () => {
    writeFileSync(join(root, 'codex.ps1'), '')
    expect(resolveCodexProbePath(join(root, 'codex.ps1'))).toBe(join(root, 'codex.ps1'))

    writeFileSync(join(root, 'codex.cmd'), '')
    expect(resolveCodexProbePath(join(root, 'codex.ps1'))).toBe(join(root, 'codex.cmd'))
    expect(resolveCodexProbePath(join(root, 'codex'))).toBe(join(root, 'codex'))
  })
})
