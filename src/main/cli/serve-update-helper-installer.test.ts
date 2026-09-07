import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildServeUpdateHelperInstallScript } from './serve-update-helper-installer'

describe('serve update helper installer', () => {
  it('writes a root-owned helper, a visudo-validated sudoers drop-in and a spool marker', () => {
    const script = buildServeUpdateHelperInstallScript({
      spoolDir: '/var/lib/orca-server-update',
      unitName: 'orca-serve.service',
      appImageTargetPath: '/opt/orca/orca-linux.AppImage',
      versionRecordPath: '/opt/orca/VERSION',
      serviceUser: 'orca'
    })
    expect(script).toContain('#!/usr/bin/env bash')
    expect(script).toContain('if [[ $(id -u) -ne 0 ]]')
    expect(script).toContain('/usr/lib/orca/serve-update-helper.sh')
    expect(script).toContain("chmod 0755 '/usr/lib/orca/serve-update-helper.sh'")
    // helper.json is published atomically from a root-owned temp copy.
    expect(script).toContain(
      "helper_json_tmp=$(mktemp '/var/lib/orca-server-update'/helper.json.XXXXXXXX)"
    )
    expect(script).toContain(
      `printf '{"helperVersion":1,"unitName":%s}' "$(printf '%s' 'orca-serve.service' | jq -Rs .)" > "$helper_json_tmp"`
    )
    // sudoers rule allows only the helper, with zero arguments
    expect(script).toContain('orca ALL=(root) NOPASSWD: /usr/lib/orca/serve-update-helper.sh ""')
    // sudoers drop-in is validated before publication and cleaned up on failure
    expect(script).toContain("visudo -cf '/etc/sudoers.d/orca-serve-update-helper.new'")
    expect(script).toContain("chmod 0440 '/etc/sudoers.d/orca-serve-update-helper.new'")
    expect(script).toContain('mv -f')
    // helper content embedded verbatim
    expect(script).toContain('#!/usr/bin/env bash')
    expect(script).toContain('{phase: "accepted"')
    expect(script).toContain('{phase: "ok"')
    // sudoers rule allows only the helper (asserted with zero-args pin above)
  })

  it('probes jq and flock before publishing any install artifact', () => {
    const script = buildServeUpdateHelperInstallScript({
      spoolDir: '/var/lib/orca-server-update',
      unitName: 'orca-serve.service',
      appImageTargetPath: '/opt/orca/orca-linux.AppImage',
      versionRecordPath: '/opt/orca/VERSION',
      serviceUser: 'orca'
    })
    const jqProbe = script.indexOf('command -v jq')
    const flockProbe = script.indexOf('command -v flock')
    const firstWrite = script.indexOf('cat >')
    expect(jqProbe).toBeGreaterThan(-1)
    expect(flockProbe).toBeGreaterThan(jqProbe)
    // Nothing is written until both dependencies are confirmed present.
    expect(firstWrite).toBeGreaterThan(flockProbe)
  })

  it('emits a helper.json that is valid JSON when the install script runs', () => {
    const script = buildServeUpdateHelperInstallScript({
      spoolDir: '/var/lib/orca-server-update',
      unitName: 'orca-serve.service',
      appImageTargetPath: '/opt/orca/orca-linux.AppImage',
      versionRecordPath: '/opt/orca/VERSION',
      serviceUser: 'orca'
    })
    const line = script.split('\n').find((l) => l.includes('helperVersion') && l.includes('printf'))
    expect(line).toBeDefined()
    // Execute the exact printf the install script would run and parse what it writes.
    const command = line!.slice(0, line!.indexOf('>')).trim()
    const output = execSync(command).toString()
    expect(JSON.parse(output)).toEqual({ helperVersion: 1, unitName: 'orca-serve.service' })
  })

  it('rejects a service user with a single quote rather than risking the sudoers rule', () => {
    const build = () =>
      buildServeUpdateHelperInstallScript({
        spoolDir: '/var/lib/orca-server-update',
        unitName: 'orca-serve.service',
        appImageTargetPath: '/opt/orca/orca-linux.AppImage',
        versionRecordPath: '/opt/orca/VERSION',
        serviceUser: "ser'vice"
      })
    expect(build).toThrow('invalid service user name')
  })
})
