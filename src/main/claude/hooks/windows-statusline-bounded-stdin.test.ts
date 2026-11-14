import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getManagedStatusLineScript } from './statusline-script'
import { WINDOWS_CLAUDE_STATUSLINE_STDIN_READER_SCRIPT } from './windows-statusline-stdin-reader'

// The statusline's tick throttle precedes any stdin capture, so ~44 of 45 ticks per interval never
// own the pipe; the one capture tick uses the bounded reader instead of the parking more.com.
describe('statusline .cmd generation', () => {
  it('puts the throttle check before any stdin read', () => {
    const script = getManagedStatusLineScript('local', 'C:\\orca\\orca.exe')
    if (process.platform !== 'win32') {
      return
    }
    const stampIndex = script.indexOf('ORCA_STATUSLINE_STAMP_FILE')
    const captureIndex = script.indexOf('claude-statusline-read.cjs')
    const moreIndex = script.indexOf('more.com')
    expect(stampIndex).toBeGreaterThan(-1)
    expect(captureIndex).toBeGreaterThan(-1)
    // Throttle comes before either stdin reader.
    expect(stampIndex).toBeLessThan(captureIndex)
    expect(stampIndex).toBeLessThan(moreIndex)
  })

  it('names the reader helper beside the .cmd and points the runtime at the launch execPath', () => {
    const script = getManagedStatusLineScript('local', 'C:\\tools\\orca-runtime.exe')
    if (process.platform !== 'win32') {
      return
    }
    expect(script).toContain('%~dp0claude-statusline-read.cjs')
    expect(script).toContain('ORCA_AGENT_HOOK_NODE=C:\\tools\\orca-runtime.exe')
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1')
  })
})

describe.skipIf(process.platform !== 'win32')('bounded stdin reader (.cjs)', () => {
  let dir = ''
  let cjsPath = ''

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-statusline-read-'))
    cjsPath = join(dir, 'claude-statusline-read.cjs')
    writeFileSync(cjsPath, WINDOWS_CLAUDE_STATUSLINE_STDIN_READER_SCRIPT, 'utf-8')
  }

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  const runReader = (outPath: string, stdin: NodeJS.ReadableStream | null, ms = 9_000) =>
    new Promise<{ code: number | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, [cjsPath, outPath], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, ms)
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, timedOut })
      })
      if (stdin) {
        stdin.pipe(child.stdin)
      } else {
        child.stdin.end()
      }
    })

  it('writes the payload file and exits on complete stdin', async () => {
    setup()
    const out = join(dir, 'payload.tmp')
    const { Readable } = await import('node:stream')
    const result = await runReader(out, Readable.from(['{"a":1}']))
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect((await import('node:fs')).readFileSync(out, 'utf-8')).toBe('{"a":1}')
  })

  it('exits with partial payload when stdin is abandoned mid-read', async () => {
    setup()
    const out = join(dir, 'payload.tmp')
    const { PassThrough } = await import('node:stream')
    const source = new PassThrough()
    // First write, then hold the pipe open without ending it.
    const resultPromise = runReader(out, source)
    source.write('{"partial"')
    const result = await resultPromise
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
  }, 15_000)
})
