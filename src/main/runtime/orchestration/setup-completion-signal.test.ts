import { describe, expect, it, vi } from 'vitest'
import {
  buildObservedSetupCommand,
  createSetupCompletionScanner,
  createSetupCompletionObservation
} from './setup-completion-signal'

describe('orchestration setup completion signal', () => {
  it('preserves a POSIX setup exit code in a visible completion signal', () => {
    const { command } = buildObservedSetupCommand(
      '/repo/.git/orca/setup-runner.sh',
      'posix',
      'token-posix'
    )

    expect(command).toContain('bash /repo/.git/orca/setup-runner.sh')
    expect(command).toContain('__ORCA_SETUP_COMPLETE__:token-posix:%s\\n')
    expect(command).toContain('"$status"')
    expect(command).toContain('exit "$status"')
  })

  it('preserves a native Windows setup path and exit code without shell interpolation', () => {
    const runnerPath = 'C:\\repo %name%!^&\\.git\\orca\\setup-runner.cmd'
    const observed = buildObservedSetupCommand(runnerPath, 'windows', 'token-windows')
    const encodedCommand = observed.command.split(' ').at(-1)
    const script = Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le')

    expect(observed.command).toContain('powershell.exe -NoLogo -NoProfile -NonInteractive')
    expect(observed.env).toEqual({ ORCA_SETUP_RUNNER_PATH: runnerPath })
    expect(script).toContain('& $runner')
    expect(script).toContain('__ORCA_SETUP_COMPLETE__:token-windows:')
    expect(script).toContain('exit $status')
    expect(script).not.toContain(runnerPath)
  })

  it('keeps a WSL runner on the POSIX completion path', () => {
    const { command } = buildObservedSetupCommand(
      '\\\\wsl.localhost\\Ubuntu\\repo\\.git\\orca\\setup-runner.sh',
      'windows',
      'token-wsl'
    )

    expect(command).toContain('bash /repo/.git/orca/setup-runner.sh')
    expect(command).toContain('__ORCA_SETUP_COMPLETE__:token-wsl:%s\\n')
    expect(command).toContain('exit "$status"')
  })

  it('routes a WSL-launched Windows-drive runner through its /mnt mount', () => {
    const { command } = buildObservedSetupCommand(
      'C:\\repo\\.git\\orca\\setup-runner.sh',
      'windows',
      'token-mnt',
      { family: 'posix', executable: 'wsl.exe' }
    )

    expect(command).toContain('bash /mnt/c/repo/.git/orca/setup-runner.sh')
    expect(command).not.toContain('bash /c/repo')
  })

  it('keeps a Git Bash runner on the MSYS drive form', () => {
    const { command } = buildObservedSetupCommand(
      'C:\\repo\\.git\\orca\\setup-runner.sh',
      'windows',
      'token-git-bash',
      { family: 'posix' }
    )

    expect(command).toContain('bash /c/repo/.git/orca/setup-runner.sh')
  })

  it('keeps a batch runner on the Windows completion path from a Git Bash pane', () => {
    // Regression (#6896): a Git Bash terminal with a batch setup script still gets a .cmd
    // runner; observing it must not shell out to bash or type a bare `cmd.exe /c` switch.
    const runnerPath = 'C:\\repo\\.git\\orca\\setup-runner.cmd'
    const observed = buildObservedSetupCommand(runnerPath, 'windows', 'token-git-bash-cmd', {
      family: 'posix'
    })

    expect(observed.command).toContain('powershell.exe -NoLogo -NoProfile -NonInteractive')
    expect(observed.command).not.toContain('bash ')
    expect(observed.env).toEqual({ ORCA_SETUP_RUNNER_PATH: runnerPath })
  })

  it('keeps the existing non-native completion behavior after a reported gap', async () => {
    const observed = createSetupCompletionObservation('token-non-native')
    observed.noteGap()
    observed.scan('__ORCA_SETUP_COMPLETE__:token-non-native:17\r\n')
    expect(observed.unknown).toBe(false)
    await expect(observed.completion).resolves.toEqual({ exitCode: 17 })
  })

  it('recognizes one completion signal across output chunk boundaries', () => {
    const onComplete = vi.fn()
    const scanner = createSetupCompletionScanner('token-chunks', onComplete)

    scanner.scan('installing...\r\n__ORCA_SETUP_COMPLETE__:wrong:0\r\n__ORCA_SETUP_COMP')
    scanner.scan('LETE__:token-chunks:1')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('7\r')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('\nPS C:\\repo>')
    scanner.scan('__ORCA_SETUP_COMPLETE__:token-chunks:0\r\n')

    expect(onComplete).toHaveBeenCalledOnce()
    expect(onComplete).toHaveBeenCalledWith(17)
  })
})

describe('native painted receipt framing', () => {
  const token = 'native:contract'
  const receipt = `ORCA_SETUP_DONE:${token}:-17;`
  it('accepts every read split and legacy LF/CRLF without accepting bare CR', () => {
    for (const frame of [
      receipt,
      `__ORCA_SETUP_COMPLETE__:${token}:0\n`,
      `__ORCA_SETUP_COMPLETE__:${token}:17\r\n`
    ]) {
      for (let cut = 0; cut <= frame.length; cut++) {
        const complete = vi.fn()
        const scanner = createSetupCompletionScanner(token, complete)
        scanner.scan(frame.slice(0, cut))
        scanner.scan(frame.slice(cut))
        scanner.scan(receipt)
        expect(complete).toHaveBeenCalledExactlyOnceWith(
          frame === receipt ? -17 : frame.includes(':17') ? 17 : 0
        )
      }
    }
    const complete = vi.fn()
    const scanner = createSetupCompletionScanner(token, complete)
    scanner.scan(`__ORCA_SETUP_COMPLETE__:${token}:0\r\x1b[2K`)
    expect(complete).not.toHaveBeenCalled()
  })

  it('does not splice across C0/C1 controls, torn escapes or control strings', () => {
    const split = receipt.indexOf(':-17')
    const controls = Array.from({ length: 32 }, (_, n) => String.fromCharCode(n)).concat(
      Array.from({ length: 33 }, (_, n) => String.fromCharCode(0x7f + n))
    )
    for (const control of controls.concat([
      '\x1b[31m',
      '\x1b[?1!p',
      '\x1b(0',
      '\x1b]0;x\x07',
      '\x1bP1$qx\x1b\\'
    ])) {
      const complete = vi.fn()
      const scanner = createSetupCompletionScanner(token, complete)
      scanner.scan(receipt.slice(0, split))
      scanner.scan(control)
      scanner.scan(receipt.slice(split))
      expect(complete, JSON.stringify(control)).not.toHaveBeenCalled()
    }
    for (const [open, close] of [
      ['\x1b]', '\x07'],
      ['\x1bPq', '\x1b\\'],
      ['\x1b_', '\x1b\\'],
      ['\x1bX', '\x1b\\'],
      ['\x1b^', '\x1b\\'],
      ['\x9d', '\x9c'],
      ['\x90q', '\x9c'],
      ['\x9fG', '\x9c']
    ]) {
      for (let cut = 0; cut <= receipt.length; cut++) {
        const complete = vi.fn()
        const scanner = createSetupCompletionScanner(token, complete)
        scanner.scan(open + receipt.slice(0, cut))
        scanner.scan(receipt.slice(cut))
        expect(complete).not.toHaveBeenCalled()
        scanner.scan(close + receipt)
        expect(complete).toHaveBeenCalledExactlyOnceWith(-17)
      }
    }
  })

  it('rejects wrong tokens, invalid/overlong/out-of-range numeric operands and non-OSC BEL termination', () => {
    for (const value of ['+0', '', '-', '1.0', '00000000000', '4294967296', '-2147483649', '0x0']) {
      const complete = vi.fn()
      createSetupCompletionScanner(token, complete).scan(`ORCA_SETUP_DONE:${token}:${value};`)
      expect(complete, value).not.toHaveBeenCalled()
    }
    const complete = vi.fn()
    const scanner = createSetupCompletionScanner(token, complete)
    scanner.scan(`ORCA_SETUP_DONE:native:wrong:0;`)
    scanner.scan(`\x1bPq\x07${receipt}`)
    expect(complete).not.toHaveBeenCalled()
    scanner.scan(`\x18${receipt}`)
    expect(complete).toHaveBeenCalledExactlyOnceWith(-17)
  })

  it('keeps control headers and string termination correct at every input split', () => {
    const hidden = `ORCA_SETUP_DONE:${token}:17;`
    const visible = `ORCA_SETUP_DONE:${token}:0;`
    for (const [open, close] of [
      ['\x1b]title;', '\x07'],
      ['\x9dtitle;', '\x9c'],
      ['\x1bP1;2$q', '\x1b\\'],
      ['\x90?1q', '\x9c'],
      ['\x1bP 1q', '\x18'],
      ['\x1bP1?x', '\x1a'],
      ['\x1b_ G', '\x1b\\'],
      ['\x9fG', '\x9c'],
      ['\x1bX', '\x1b\\'],
      ['\x1b^', '\x9c'],
      ['\x1b[1?2', 'm'],
      ['\x9b 1', 'm'],
      ['\x1b(', 'B']
    ]) {
      const input = open + hidden + close + visible
      for (let cut = 0; cut <= input.length; cut++) {
        const complete = vi.fn()
        const scanner = createSetupCompletionScanner(token, complete)
        scanner.scan(input.slice(0, cut))
        scanner.scan(input.slice(cut))
        expect(complete, JSON.stringify({ open, cut })).toHaveBeenCalledExactlyOnceWith(0)
      }
    }
    for (const code of [-2147483648, 4294967295]) {
      const complete = vi.fn()
      createSetupCompletionScanner(token, complete).scan(`ORCA_SETUP_DONE:${token}:${code};`)
      expect(complete).toHaveBeenCalledExactlyOnceWith(code)
    }
  })

  it('keeps a gap/missing origin unknown, preserves continuous large reads and publishes only after admission', async () => {
    const fresh = createSetupCompletionObservation(token, true)
    const seen = vi.fn()
    void fresh.completion.then(seen)
    const prelude = 'x'.repeat(100_000)
    fresh.scan(prelude, prelude.length, false, prelude.length)
    fresh.scan(receipt, receipt.length, false, prelude.length + receipt.length)
    await Promise.resolve()
    expect(seen).not.toHaveBeenCalled()
    expect(fresh.unknown).toBe(false)
    fresh.publish()
    await expect(fresh.completion).resolves.toEqual({ exitCode: -17 })
    fresh.noteGap()
    expect(fresh.unknown).toBe(false)
    for (const missing of ['gap', 'range', 'origin']) {
      const observed = createSetupCompletionObservation(token, missing !== 'origin')
      const done = vi.fn()
      void observed.completion.then(done)
      if (missing === 'gap') {
        observed.noteGap()
      }
      observed.scan(receipt, receipt.length, false, receipt.length + (missing === 'range' ? 1 : 0))
      observed.publish()
      await Promise.resolve()
      expect(observed.unknown).toBe(true)
      expect(done).not.toHaveBeenCalled()
    }
  })
})
