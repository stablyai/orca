import { describe, expect, it } from 'vitest'
import type { CliStatusResult } from '../shared/runtime-types'
import type { RemoteServerUpdateSupport } from '../shared/remote-server-update'
import { formatRemoteUpdateSupportLines } from './serve-manual-update-format'
import { formatCliStatus } from './format'

const MANUAL_SUPPORT: RemoteServerUpdateSupport = {
  installMode: 'unsupported-headless-serve',
  automatic: false,
  reason: 'manual-service-update-required',
  manualUpdate: {
    method: 'deb',
    check: 'update-available',
    currentVersion: '1.4.159',
    latestVersion: '1.4.200',
    releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.200',
    steps: ["sudo /usr/bin/apt install -- '/tmp/orca-1.4.200.deb'", 'Restart the service unit'],
    documentationUrl: 'https://docs.example/upgrade'
  }
}

function statusWith(support?: RemoteServerUpdateSupport): CliStatusResult {
  return {
    app: { running: true, pid: 42 },
    runtime: {
      state: 'ready',
      reachable: true,
      runtimeId: 'runtime-1',
      appVersion: '1.4.159',
      ...(support ? { remoteUpdateSupport: support } : {})
    },
    graph: { state: 'ready' }
  }
}

describe('formatRemoteUpdateSupportLines', () => {
  it('adds nothing for a host that reports no update support', () => {
    expect(formatRemoteUpdateSupportLines(undefined)).toEqual([])
  })

  it('names the version that is out and the exact numbered commands', () => {
    expect(formatRemoteUpdateSupportLines(MANUAL_SUPPORT)).toEqual([
      'updateAutomatic: false',
      'updateInstallMode: unsupported-headless-serve',
      'updateReason: manual-service-update-required',
      'updateMethod: deb',
      'updateCheck: update-available',
      'updateLatestVersion: 1.4.200',
      'updateRelease: https://github.com/stablyai/orca/releases/tag/v1.4.200',
      'updateSteps:',
      "  1. sudo /usr/bin/apt install -- '/tmp/orca-1.4.200.deb'",
      '  2. Restart the service unit',
      'updateDocs: https://docs.example/upgrade'
    ])
  })

  it('reports an unknown latest version rather than implying the host is current', () => {
    const lines = formatRemoteUpdateSupportLines({
      ...MANUAL_SUPPORT,
      manualUpdate: {
        ...MANUAL_SUPPORT.manualUpdate!,
        check: 'pending',
        latestVersion: null,
        releaseUrl: null,
        steps: []
      }
    })

    expect(lines).toContain('updateCheck: pending')
    expect(lines).toContain('updateLatestVersion: unknown')
    expect(lines.some((line) => line.startsWith('updateSteps'))).toBe(false)
  })

  it('leaves an automatic-update host with support lines but no manual block', () => {
    const lines = formatRemoteUpdateSupportLines({
      installMode: 'interactive',
      automatic: true,
      reason: 'available'
    })

    expect(lines).toEqual([
      'updateAutomatic: true',
      'updateInstallMode: interactive',
      'updateReason: available'
    ])
  })
})

describe('formatCliStatus', () => {
  it('surfaces the update contract through `orca status`', () => {
    const output = formatCliStatus(statusWith(MANUAL_SUPPORT))

    expect(output).toContain('appVersion: 1.4.159')
    expect(output).toContain('updateLatestVersion: 1.4.200')
    expect(output).toContain("  1. sudo /usr/bin/apt install -- '/tmp/orca-1.4.200.deb'")
  })

  it('keeps the original status lines for a host that reports no update support', () => {
    expect(formatCliStatus(statusWith())).toBe(
      [
        'appRunning: true',
        'pid: 42',
        'desktopWindowStatus: unknown',
        'runtimeState: ready',
        'runtimeReachable: true',
        'runtimeConnectionState: unknown',
        'runtimeId: runtime-1',
        'graphState: ready',
        'appVersion: 1.4.159'
      ].join('\n')
    )
  })
})
