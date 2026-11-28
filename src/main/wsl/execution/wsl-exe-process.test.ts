import { expect, it } from 'vitest'
import { parseWslDistros } from '../discovery/wsl-distro-list-output'
import { wslExeStdout } from './wsl-exe-process'

const listed = (bytes: Buffer): string[] =>
  parseWslDistros(
    wslExeStdout({
      code: 0,
      signal: null,
      stdout: '',
      stdoutBytes: bytes,
      stderr: '',
      timedOut: false
    })
  )

// Measured on WSL 3.0.5: `wsl.exe --list --quiet` writes UTF-16LE with no BOM, also with WSL_UTF8 set.
it('keeps a distro name outside ASCII, whether wsl.exe wrote UTF-16LE or UTF-8', () => {
  expect(listed(Buffer.from('开发环境\r\nUbuntu\r\n', 'utf16le'))).toEqual(['开发环境', 'Ubuntu'])
  expect(listed(Buffer.from('开发环境\r\nUbuntu\r\n', 'utf8'))).toEqual(['开发环境', 'Ubuntu'])
})
