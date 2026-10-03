import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readLaunchSource(): { serve: string; desktop: string } {
  const source = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
    'utf8'
  )
  const serveStart = source.indexOf('async function launchServeMode(')
  const desktopStart = source.indexOf('\nasync function launchDesktopMode', serveStart)
  const desktopEnd = source.indexOf(
    '\nexport async function initializeMainProcessRuntimeLaunch',
    desktopStart
  )
  return {
    serve: source.slice(serveStart, desktopStart),
    desktop: source.slice(desktopStart, desktopEnd)
  }
}

describe('serve relay wiring (18504 Problem 1)', () => {
  it('starts the relay pairing provider in serve mode after RPC start', () => {
    const { serve } = readLaunchSource()
    // Why awaited, not just present: without await, printServeReady could run before the provider registers.
    expect(serve).toContain('await startDesktopRelayService(runtimeRpc)')
    expect(serve.indexOf('await runtimeRpc.start()')).toBeGreaterThanOrEqual(0)
    expect(serve.indexOf('await runtimeRpc.start()')).toBeLessThan(
      serve.indexOf('await startDesktopRelayService(runtimeRpc)')
    )
    expect(serve.indexOf('await startDesktopRelayService(runtimeRpc)')).toBeLessThan(
      serve.indexOf('await printServeReady(serveOptions)')
    )
  })

  it('keeps the desktop relay wiring on the shared starter', () => {
    const { desktop } = readLaunchSource()
    expect(desktop).toContain('await startDesktopRelayService(runtimeRpc)')
    expect(desktop).not.toContain('new DesktopRelayService(')
  })
})
