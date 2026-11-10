import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { DesktopScriptRuntimeHost } from './desktop-script-runtime-host'

/** Exercise real PowerShell framing and flushing; fake-child unit tests cannot verify them. */
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
})
