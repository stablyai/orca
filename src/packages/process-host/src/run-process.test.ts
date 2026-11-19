import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { runProcess, runProcessSync } from './run-process'
import { resolveSpawn } from './spawn-resolution'
import { WINDOWS_ARGUMENT_CORPUS } from './__fixtures__/windows-argument-corpus'

describe('resolveSpawn', () => {
  it('always hides the console and never uses a shell', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const resolved = resolveSpawn({ program: 'git', args: ['status'] }, platform)
      expect(resolved.options.windowsHide).toBe(true)
      expect(resolved.options.shell).toBe(false)
    }
  })

  it('never lets a corpus argument reach cmd as an operator', () => {
    for (const { name, value } of WINDOWS_ARGUMENT_CORPUS) {
      const line = resolveSpawn({ program: 'C:\\a.cmd', args: [value] }, 'win32').args[0]!
      const body = line.slice('/d /v:off /s /c "'.length, -1)
      // cmd uses quote parity to decide whether metacharacters are operators.
      let quoted = false
      for (const char of body) {
        if (char === '"') {
          quoted = !quoted
          continue
        }
        if ('&|<>'.includes(char)) {
          expect(quoted, `${name}: bare ${char} would parse as a cmd operator`).toBe(true)
        }
      }
      expect(quoted, `${name}: line ends mid-quote`).toBe(false)
    }
  })
})

describe('runProcessSync', () => {
  it.each([false, true])('accepts string stdin with byte capture %s', (captureStdoutAsBytes) => {
    const input = 'nonsecret-probe-λ'
    const result = runProcessSync({
      program: process.execPath,
      args: [
        '-e',
        'process.stdin.pipe(process.stdout, { end: false }); process.stdin.on("end", () => { process.stdout.write(Buffer.from([0,255])); process.stderr.write("diagnostic λ") })'
      ],
      input,
      captureStdoutAsBytes
    })
    expect(result).toMatchObject({
      code: 0,
      stdout: captureStdoutAsBytes ? '' : `${input}\u0000�`,
      stderr: 'diagnostic λ',
      timedOut: false,
      outputTruncated: false
    })
    expect(result.stdoutBytes).toEqual(
      captureStdoutAsBytes ? Buffer.concat([Buffer.from(input), Buffer.from([0, 255])]) : undefined
    )
  })
})

describe('bounded output', () => {
  it('reports a clipped answer instead of passing it off as the whole one', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(64))'],
      maxOutputBytes: 8
    })
    expect(result.stdout).toBe('xxxxxxxx')
    expect(result.outputTruncated).toBe(true)
  })

  it('does not call output that exactly fills the cap truncated', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(8))'],
      maxOutputBytes: 8
    })
    expect(result.stdout).toBe('xxxxxxxx')
    expect(result.code).toBe(0)
    expect(result.outputTruncated).toBe(false)
  })
})

describe('unkillable children', () => {
  it('settles a timeout after the child reports ready', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: [
        '-e',
        'process.on("SIGTERM", () => {}); process.stderr.write("ready"); setInterval(() => {}, 1000)'
      ],
      timeoutMs: 2_000
    })
    expect(result.stderr).toBe('ready')
    expect(result.timedOut).toBe(true)
  }, 20_000)
})

describe('abort', () => {
  it('settles an abort after the child reports ready', async () => {
    const controller = new AbortController()
    let stderr = ''
    const pending = runProcess({
      program: process.execPath,
      args: [
        '-e',
        'process.on("SIGTERM", () => {}); process.stderr.write("ready"); setInterval(() => {}, 1000)'
      ],
      timeoutMs: 60_000,
      signal: controller.signal,
      onStderr: (chunk) => {
        stderr += chunk.toString()
      }
    })
    try {
      await expect.poll(() => stderr, { timeout: 10_000 }).toBe('ready')
      controller.abort()
      const result = await pending
      expect(result.timedOut).toBe(false)
    } finally {
      controller.abort()
      await pending
    }
  }, 20_000)

  it.skipIf(process.platform === 'win32')(
    'kills the process group and waits for confirmed root exit with a termination barrier',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'run-process-barrier-'))
      const marker = path.join(root, 'descendant-state')
      const descendantScript =
        // Trap before ready: an abort right after ready must not hit sh's default TERM action.
        `trap 'printf signaled > "$1"' TERM;printf ready > "$1";` + `while :;do sleep 1;done`
      const controller = new AbortController()
      const pending = runProcess({
        program: process.execPath,
        args: [
          '-e',
          `const {spawn}=require('node:child_process');` +
            `spawn('/bin/sh',${JSON.stringify(['-c', descendantScript, 'sh', marker])},{stdio:'ignore'});` +
            `setInterval(()=>{},1000)`
        ],
        timeoutMs: 60_000,
        signal: controller.signal,
        terminationBarrier: true
      })
      try {
        await expect
          .poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 10_000 })
          .toBe('ready')
        controller.abort()
        await pending
        await expect.poll(() => readFile(marker, 'utf8')).toBe('signaled')
      } finally {
        controller.abort()
        await pending
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )
})

describe('stdin delivery failures', () => {
  it('survives a child that exits without reading its input', async () => {
    // A queued stdin write may fail with EPIPE after the child exits.
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.exit(7)'],
      input: 'x'.repeat(1024 * 1024),
      timeoutMs: 15_000
    })
    expect(result.code).toBe(7)
    expect(result.timedOut).toBe(false)
  }, 20_000)
})

describe('a signal that is already aborted', () => {
  it('stops the child instead of running it to the timeout', async () => {
    const controller = new AbortController()
    controller.abort()
    const onChildTerminated = vi.fn()
    const result = await runProcess({
      program: path.join(tmpdir(), 'orca-must-not-spawn'),
      timeoutMs: 30_000,
      signal: controller.signal,
      onChildTerminated
    })
    expect(result.timedOut).toBe(false)
    expect(onChildTerminated).toHaveBeenCalledOnce()
  }, 20_000)
})
