import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareDevCliTerminalWrappers } from './dev-cli-terminal-wrapper.mjs'

describe('dev CLI terminal wrappers', () => {
  it.skipIf(process.platform === 'win32' || !process.env.BUN_EXECUTABLE)(
    'executes Bun from a path containing shell metacharacters without expanding them',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "orca '$HOME `literal` "))
      try {
        const runtimeDirectory = path.join(
          root,
          'out',
          'cli-runtime',
          `${process.platform}-${process.arch}`
        )
        mkdirSync(runtimeDirectory, { recursive: true })
        symlinkSync(process.env.BUN_EXECUTABLE, path.join(runtimeDirectory, 'bun-runtime'))
        mkdirSync(path.join(root, 'out', 'cli'), { recursive: true })
        writeFileSync(
          path.join(root, 'out', 'cli', 'index.js'),
          'console.log(JSON.stringify({bun:process.versions.bun,profile:process.env.ORCA_USER_DATA_PATH,args:process.argv.slice(2)}))'
        )
        const profile = path.join(root, 'profile')
        const { binDir } = prepareDevCliTerminalWrappers({
          repoRoot: root,
          userDataPath: profile,
          electronExecutable: '/electron'
        })
        const result = execFileSync(path.join(binDir, 'orca'), ['line\nbreak'], {
          encoding: 'utf8',
          env: { ...process.env, BUN_OPTIONS: '--invalid' }
        })
        expect(JSON.parse(result)).toEqual({
          bun: expect.any(String),
          profile,
          args: ['line\nbreak']
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('writes profile-scoped Windows wrappers for worker terminals', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-dev-terminal-wrapper-'))
    const userDataPath = path.join(root, 'profile')
    prepareDevCliTerminalWrappers({
      repoRoot: root,
      userDataPath,
      electronExecutable: path.join(root, 'electron.exe'),
      platform: 'win32'
    })

    const wrapper = readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca-dev.cmd'), 'utf8')
    expect(wrapper).toContain(`set "ORCA_USER_DATA_PATH=${userDataPath}"`)
    expect(wrapper).toContain('set "ORCA_DEV_CLI_INVOCATION=1"')
    expect(wrapper).toContain(`"${path.join(root, 'out', 'cli', 'index.js')}" %*`)
    expect(readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca.cmd'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca-dev.cmd'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca.cmd'), 'utf8')).toBe(wrapper)
  })

  it('escapes literal percent signs in every Windows batch path', () => {
    const root = path.join(mkdtempSync(path.join(tmpdir(), 'orca-dev-terminal-wrapper-')), '%repo%')
    const userDataPath = path.join(root, '%profile%')
    const electronExecutable = path.join(root, '%electron%', 'electron.exe')
    prepareDevCliTerminalWrappers({
      repoRoot: root,
      userDataPath,
      electronExecutable,
      platform: 'win32'
    })

    const wrapper = readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca-dev.cmd'), 'utf8')
    expect(wrapper).toContain(`set "ORCA_USER_DATA_PATH=${userDataPath.replaceAll('%', '%%')}"`)
    expect(wrapper).toContain(
      `set "ORCA_APP_EXECUTABLE=${electronExecutable.replaceAll('%', '%%')}"`
    )
    expect(wrapper).toContain(
      `"${path.join(root, 'out', 'cli', 'index.js').replaceAll('%', '%%')}" %*`
    )
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca-dev.cmd'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca.cmd'), 'utf8')).toBe(wrapper)
  })

  it('writes executable-style POSIX wrappers with the same profile identity', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-dev-terminal-wrapper-'))
    const userDataPath = path.join(root, 'profile')
    prepareDevCliTerminalWrappers({
      repoRoot: root,
      userDataPath,
      electronExecutable: path.join(root, 'electron'),
      platform: 'linux'
    })

    const wrapper = readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca-dev'), 'utf8')
    expect(wrapper).toContain(`export ORCA_USER_DATA_PATH='${userDataPath}'`)
    expect(wrapper).toContain('export ORCA_DEV_CLI_INVOCATION=1')
    expect(wrapper).toContain(
      `exec '${path.join(root, 'out', 'cli-runtime', `linux-${process.arch}`, 'bun-runtime')}'`
    )
    expect(readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca-dev'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca'), 'utf8')).toBe(wrapper)
  })
})
