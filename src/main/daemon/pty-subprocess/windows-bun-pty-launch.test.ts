import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWindowsBunPtyLaunch, resolveWindowsBunPtyGateEntry } from './windows-bun-pty-launch'
import { readWindowsBunPtyGateRequest, windowsBunPtyChildSpec } from './windows-bun-pty-gate'

const workerPath = join(__dirname, 'windows-bun-pty-launch.test.ts')

describe('Windows Bun PTY gated launch', () => {
  it('preserves long executable argv without cmd interpretation and releases only once', () => {
    const file = 'C:\\状 態\\%tool%&shell.exe'
    const args = ['a b', 'c"d', 'e%F%g', 'h&i', 'j^k', 'bang!', 'line\nbreak', 'x'.repeat(16000)]
    const launch = createWindowsBunPtyLaunch(
      { file, args, cwd: 'C:\\work tree', env: { TERM: 'xterm-256color' } },
      { workerPath }
    )
    const gate = launch.env.ORCA_BUN_PTY_JOB_GATE
    const directory = dirname(gate)
    try {
      const request = readWindowsBunPtyGateRequest(launch.command.at(-1)!)
      expect(request).toMatchObject({ file, args, cwd: 'C:\\work tree', gatePath: gate })
      const child = windowsBunPtyChildSpec(request, launch.env)
      expect(child.program).toBe(file)
      expect(child.args).toEqual(args)
      expect(child.windowsVerbatimArguments).toBeUndefined()
      expect(child.stdio).toBe('inherit')
      expect(child.env).not.toHaveProperty('ORCA_BUN_PTY_JOB_GATE')
      expect(launch.windowsVerbatimArguments).toBe(false)
      expect(launch.command).toContain('--no-env-file')
      expect(launch.command).toContain(`--config=${join(directory, 'bunfig.toml')}`)
      expect(launch.command).toContain(`--cwd=${directory}`)
      expect(launch.command.join(' ').length).toBeLessThan(8191)
      const clear = readFileSync(join(directory, 'clear.cmd'))
      expect(clear.includes(Buffer.from('\x1b[3J\x1b[2J\x1b[H'))).toBe(true)
      expect(existsSync(gate)).toBe(false)
      launch.release()
      launch.release()
      expect(existsSync(gate)).toBe(true)
    } finally {
      launch.dispose()
      launch.dispose()
    }
    expect(existsSync(directory)).toBe(false)
  })

  it.each(['/K', '/k', '/C', '/c'])(
    'preserves direct cmd %s command text without CRT escaping',
    (commandSwitch) => {
      const file = 'C:\\Windows\\System32\\CMD.EXE'
      const args = [commandSwitch, 'chcp 65001 > nul & echo 状態%VALUE%!']
      const launch = createWindowsBunPtyLaunch({ file, args, env: {} }, { workerPath })
      try {
        const child = windowsBunPtyChildSpec(
          readWindowsBunPtyGateRequest(launch.command.at(-1)!),
          launch.env
        )
        expect(child.program).toBe(file)
        expect(child.args).toEqual(args)
        expect(child.windowsVerbatimArguments).toBe(true)
      } finally {
        launch.dispose()
      }
    }
  )

  it('withholds runtime preload options from the gate while preserving the shell environment', () => {
    const env = {
      NODE_OPTIONS: '--require C:\\workspace\\hook.js',
      BUN_OPTIONS: '--preload hook.js',
      TERM: 'xterm-256color'
    }
    const launch = createWindowsBunPtyLaunch({ file: 'shell.exe', args: [], env }, { workerPath })
    try {
      expect(launch.env).not.toHaveProperty('NODE_OPTIONS')
      expect(launch.env).not.toHaveProperty('BUN_OPTIONS')
      expect(
        windowsBunPtyChildSpec(readWindowsBunPtyGateRequest(launch.command.at(-1)!), launch.env).env
      ).toEqual(env)
    } finally {
      launch.dispose()
    }
  })

  it('fails before launch when the gate entry is missing', () => {
    expect(() =>
      createWindowsBunPtyLaunch(
        { file: 'shell.exe', args: [], env: {} },
        { workerPath: join(workerPath, 'missing') }
      )
    ).toThrow('Windows PTY gate entry not found')
  })

  it('rejects a cmd-unsafe line break before creating launch state', () => {
    expect(() =>
      createWindowsBunPtyLaunch(
        { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'first\nsecond'], env: {} },
        { workerPath }
      )
    ).toThrow('cmd.exe cannot receive an argument containing a line break')
  })

  it('resolves adjacent, factored-chunk, and unpacked desktop layouts', () => {
    const name = 'windows-bun-pty-gate-entry.js'
    expect(resolveWindowsBunPtyGateEntry('/orcad', () => true)).toBe(join('/orcad', name))
    expect(
      resolveWindowsBunPtyGateEntry(
        '/app/out/main/chunks',
        (path) => path === join('/app/out/main', name)
      )
    ).toBe(join('/app/out/main', name))
    expect(resolveWindowsBunPtyGateEntry('/resources/app.asar/out/main', () => true)).toBe(
      join('/resources/app.asar.unpacked/out/main', name)
    )
  })
})
