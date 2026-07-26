import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why: ssh-relay-deploy imports `electron` (app) and the telemetry client at module load; mock both
// so the pure probe helpers can be exercised without an Electron runtime or a live posthog client.
vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('../telemetry/client', () => ({
  track: vi.fn()
}))

import { __nativeDepsProbeTestables } from './ssh-relay-deploy'
import { track } from '../telemetry/client'
import type { RemoteHostPlatform } from './ssh-remote-platform'

const {
  NATIVE_DEPS_MISSING_PREFIX,
  NODE_PTY_PATCH_SKIPPED_PREFIX,
  nativeDepsProbeJs,
  missingNativeDepsFromProbe,
  parseNodePtyPatchSkipSignal,
  reportNodePtyPatchSkipFromProbe
} = __nativeDepsProbeTestables

const OK_TOKEN = 'ORCA-NATIVE-DEPS-OK'
const win32HostPlatform = { relayPlatform: 'win32-x64' } as unknown as RemoteHostPlatform

describe('native-deps probe: node-pty console-list patch drift (issue #9638)', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear()
  })

  it('classifies the patch separately so an UNEXPECTED source degrades, not fails, node-pty', () => {
    const probeJs = nativeDepsProbeJs(OK_TOKEN)
    expect(probeJs).toContain('classifyNodePtyConsoleListAgent(process.cwd())')
    // Only a recognized-but-unpatched original re-marks node-pty missing (repair re-applies).
    expect(probeJs).toContain('c.outcome==="unpatched-original"')
    expect(probeJs).toContain(NODE_PTY_PATCH_SKIPPED_PREFIX)
    // The classification only runs once node-pty itself loaded.
    expect(probeJs).toContain('if(nptyOk&&process.platform==="win32")')
  })

  it('(c) UNEXPECTED source: node-pty stays available and a skip signal is present', () => {
    const output = `${NODE_PTY_PATCH_SKIPPED_PREFIX}skipped-unexpected-source:0d010879bb66:1.1.0\n${OK_TOKEN}`

    // Degraded, not missing: the probe still emits the OK token, so the deploy proceeds and no dep
    // is flagged missing — the skip token never suppresses the success signal.
    expect(output.includes(OK_TOKEN)).toBe(true)
    expect(output.includes(NATIVE_DEPS_MISSING_PREFIX)).toBe(false)

    expect(parseNodePtyPatchSkipSignal(output)).toEqual({
      reason: 'unexpected_source',
      sha256Prefix: '0d010879bb66',
      version: '1.1.0'
    })

    reportNodePtyPatchSkipFromProbe(win32HostPlatform, output)
    expect(track).toHaveBeenCalledWith('relay_node_pty_patch_skipped', {
      reason: 'unexpected_source',
      node_pty_version: '1.1.0',
      source_sha_prefix: '0d010879bb66',
      relay_platform: 'win32-x64'
    })
  })

  it('(c) UNEXPECTED version reports a distinct telemetry reason', () => {
    const output = `${NODE_PTY_PATCH_SKIPPED_PREFIX}skipped-unexpected-version:abcdef012345:1.2.0-beta.11\n${OK_TOKEN}`
    expect(parseNodePtyPatchSkipSignal(output)?.reason).toBe('unexpected_version')

    reportNodePtyPatchSkipFromProbe(win32HostPlatform, output)
    expect(track).toHaveBeenCalledWith(
      'relay_node_pty_patch_skipped',
      expect.objectContaining({ reason: 'unexpected_version', node_pty_version: '1.2.0-beta.11' })
    )
  })

  it('(d) node-pty missing entirely is still reported as missing (deploy stays fatal)', () => {
    const output = `${NATIVE_DEPS_MISSING_PREFIX}node-pty`
    expect(missingNativeDepsFromProbe(output)).toEqual(['node-pty'])
    // A genuine node-pty failure carries no patch-skip signal, so no degrade telemetry fires.
    expect(parseNodePtyPatchSkipSignal(output)).toBeNull()
    reportNodePtyPatchSkipFromProbe(win32HostPlatform, output)
    expect(track).not.toHaveBeenCalled()
  })

  it('healthy output emits no drift telemetry', () => {
    reportNodePtyPatchSkipFromProbe(win32HostPlatform, OK_TOKEN)
    expect(track).not.toHaveBeenCalled()
    expect(parseNodePtyPatchSkipSignal(OK_TOKEN)).toBeNull()
  })
})
