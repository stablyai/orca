import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
import { DesktopScriptRuntimeHost } from './desktop-script-runtime-host'
import { startServeChannel } from './desktop-script-serve-channel'
import {
  PREFERRED_WINDOWS_EXECUTION_POLICY,
  windowsPowerShellRuntimeArgs
} from './windows-powershell-execution-policy'

/**
 * The other half of the serve-mode proof: the unit test drives a fake child,
 * this one drives the real `runtime.ps1 -Serve` on a real Windows box.
 *
 * Both are needed. The framing that matters — one NDJSON line per response,
 * megabyte-scale screenshot payloads, a console writer that actually flushes —
 * only exists in PowerShell, and a fake child cannot disprove any of it.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

const SCRIPT_PATH = resolve(__dirname, '../../../native/computer-use-windows/runtime.ps1')

describeOnWindows('runtime.ps1 serve mode', () => {
  let host: DesktopScriptRuntimeHost | null = null
  let spawns = 0

  function startHost(): DesktopScriptRuntimeHost {
    spawns = 0
    host = new DesktopScriptRuntimeHost(SCRIPT_PATH, {
      warn: () => {},
      spawn: (spec) => {
        spawns++
        return spawnProcess(spec)
      }
    })
    return host
  }

  afterEach(() => {
    host?.dispose()
    host = null
  })

  it('answers repeated operations from a single PowerShell process', async () => {
    const runtime = startHost()

    await expect(runtime.request({ tool: 'handshake' })).resolves.toMatchObject({
      ok: true,
      capabilities: { protocolVersion: 1, provider: 'orca-computer-use-windows' }
    })

    const apps = await runtime.request({ tool: 'list_apps' })
    expect(apps.ok).toBe(true)
    expect(Array.isArray(apps.apps)).toBe(true)

    await expect(runtime.request({ tool: 'handshake' })).resolves.toMatchObject({ ok: true })

    expect(spawns).toBe(1)
  })

  it('returns a structured error for a bad request without killing the helper', async () => {
    const runtime = startHost()

    await expect(runtime.request({ tool: 'not_a_tool' })).resolves.toMatchObject({ ok: false })
    await expect(runtime.request({ tool: 'handshake' })).resolves.toMatchObject({ ok: true })
    expect(spawns).toBe(1)
  })

  /**
   * The host can only write well-formed JSON, so the parse-failure branch of the
   * serve loop is unreachable through it. Driving the channel directly is the
   * only way to prove what the real PowerShell answers.
   */
  it('echoes the id it can recover when a request will not parse', async () => {
    const answer = await answerRawLine('{"tool":"handshake","requestId":7')

    // Tagged, so the host resolves the waiting request with a failed operation
    // instead of reading an untagged line as a desynchronised stream.
    expect(answer).toMatchObject({ ok: false, requestId: 7 })
    expect(String(answer.error)).not.toBe('')
  })

  it('reports an error for a line with no recoverable id', async () => {
    const answer = await answerRawLine('{"tool":"handshake"')

    expect(answer).toMatchObject({ ok: false })
    expect(answer.requestId).toBeUndefined()
    expect(String(answer.error)).not.toBe('')
  })
})

/** One raw line into a real `runtime.ps1 -Serve`, and the line it writes back. */
function answerRawLine(raw: string): Promise<Record<string, unknown>> {
  return new Promise((settle, fail) => {
    const channel = startServeChannel(
      {
        program: windowsPowerShellPath(),
        args: windowsPowerShellRuntimeArgs(SCRIPT_PATH, PREFERRED_WINDOWS_EXECUTION_POLICY, [
          '-Serve'
        ]),
        env: process.env
      },
      spawnProcess,
      {
        onLine: (line) => {
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(line) as Record<string, unknown>
          } catch {
            return
          }
          if (parsed.ready === true) {
            channel.write(`${raw}\n`, fail)
            return
          }
          channel.stop()
          settle(parsed)
        },
        onGone: (detail) => fail(new Error(`helper exited before answering: ${detail}`)),
        onOverflow: () => {
          channel.stop()
          fail(new Error('helper overflowed the response buffer'))
        }
      }
    )
  })
}
