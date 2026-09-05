import { describe, expect, it } from 'vitest'
import { buildServeUpdateHelperScript } from './serve-update-helper-script'

describe('serve update helper script', () => {
  it('embeds spool paths and unit name quoted', () => {
    const script = buildServeUpdateHelperScript({
      spoolDir: "/var/lib/orca-server-up'date",
      unitName: 'orca-serve.service',
      appImageTargetPath: '/opt/orca/orca-linux.AppImage',
      versionRecordPath: '/opt/orca/VERSION'
    })
    expect(script).toContain(`SPOOL_DIR='/var/lib/orca-server-up'"'"'date'`)
    expect(script).toContain("UNIT_NAME='orca-serve.service'")
    expect(script).toContain("APPIMAGE_TARGET='/opt/orca/orca-linux.AppImage'")
    expect(script).toContain("VERSION_TARGET='/opt/orca/VERSION'")
    expect(script).toContain('#!/usr/bin/env bash')
    expect(script).toContain('systemctl stop "$UNIT_NAME"')
    expect(script).toContain('systemctl start "$UNIT_NAME"')
    expect(script).toContain('"phase":"accepted"')
    expect(script).toContain('"phase":"ok"')
    expect(script).toContain('"phase":"failed"')
    expect(script).toContain('"phase":"rejected"')
  })

  it('writes accepted before any mutating step', () => {
    const script = buildServeUpdateHelperScript({
      spoolDir: '/var/lib/orca-server-update',
      unitName: 'orca-serve.service',
      appImageTargetPath: '/opt/orca/orca-linux.AppImage',
      versionRecordPath: '/opt/orca/VERSION'
    })
    const acceptedAt = script.indexOf('"phase":"accepted"')
    const stopAt = script.indexOf('systemctl stop "$UNIT_NAME"')
    expect(acceptedAt).toBeGreaterThan(-1)
    expect(stopAt).toBeGreaterThan(acceptedAt)
  })
})
