import { describe, expect, it } from 'vitest'
import { buildServeUpdateHelperScript } from './serve-update-helper-script'

const INPUT = {
  spoolDir: '/var/lib/orca-server-update',
  unitName: 'orca-serve.service',
  appImageTargetPath: '/opt/orca/orca-linux.AppImage',
  versionRecordPath: '/opt/orca/VERSION'
}

describe('serve update helper script', () => {
  it('embeds spool paths and unit name quoted', () => {
    const script = buildServeUpdateHelperScript({
      ...INPUT,
      spoolDir: "/var/lib/orca-server-up'date"
    })
    expect(script).toContain(`SPOOL_DIR='/var/lib/orca-server-up'"'"'date'`)
    expect(script).toContain("UNIT_NAME='orca-serve.service'")
    expect(script).toContain("APPIMAGE_TARGET='/opt/orca/orca-linux.AppImage'")
    expect(script).toContain("VERSION_TARGET='/opt/orca/VERSION'")
    expect(script).toContain('#!/usr/bin/env bash')
    expect(script).toContain('systemctl stop "$UNIT_NAME"')
    expect(script).toContain('systemctl start "$UNIT_NAME"')
    expect(script).toContain('{phase: "accepted"')
    expect(script).toContain('{phase: "ok"')
    expect(script).toContain('{phase: "failed"')
    expect(script).toContain('{phase: "rejected"')
  })

  it('writes accepted before any mutating step', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    const acceptedAt = script.indexOf('{phase: "accepted"')
    const stopAt = script.indexOf('systemctl stop "$UNIT_NAME"')
    expect(acceptedAt).toBeGreaterThan(-1)
    expect(stopAt).toBeGreaterThan(acceptedAt)
  })

  it('serializes concurrent runs with flock and removes the lock file risk by exec-fd', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    expect(script).toContain('flock -w 30 9')
    expect(script).toContain('exec 9>')
  })

  it('refuses downgrades and no-ops when already at the target version', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    const downgradeCheck = script.indexOf('refusing downgrade')
    const noOpCheck = script.indexOf('already at version')
    expect(downgradeCheck).toBeGreaterThan(-1)
    expect(noOpCheck).toBeGreaterThan(-1)
    expect(downgradeCheck).toBeLessThan(script.indexOf('{phase: "accepted"'))
    expect(noOpCheck).toBeLessThan(script.indexOf('{phase: "accepted"'))
  })

  it('snapshots the current binary and rolls back on every post-acceptance failure', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    const backup = script.indexOf('APPIMAGE_TARGET.update-backup')
    const snapshot = script.indexOf('cp -p -- "$APPIMAGE_TARGET" "$BACKUP"')
    const rollbackDef = script.indexOf('rollback_and_fail() {')
    const rollbackAtStop = script.indexOf('rollback_and_fail "could not stop $UNIT_NAME"')
    expect(backup).toBeGreaterThan(-1)
    expect(snapshot).toBeGreaterThan(backup)
    // Rollback function is defined before the snapshot, then invoked after every risky step.
    expect(rollbackDef).toBeLessThan(snapshot)
    expect(rollbackAtStop).toBeGreaterThan(snapshot)
    // start-failure and readiness-failure both route through rollback, not bare fail.
    expect(script).toContain('rollback_and_fail "new binary failed to start"')
    expect(script).toContain('rollback_and_fail "new binary did not report ready')
  })

  it('verifies readiness via the new MainPID journal orca_server_ready line', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    const startAt = script.indexOf('systemctl start "$UNIT_NAME"')
    const readyAt = script.indexOf('orca_server_ready')
    const okAt = script.indexOf('{phase: "ok"')
    expect(readyAt).toBeGreaterThan(startAt)
    expect(okAt).toBeGreaterThan(readyAt)
    expect(script).toContain('journalctl -u "$UNIT_NAME" _PID="$pid"')
    expect(script).toContain('systemctl show -p MainPID --value "$UNIT_NAME"')
  })

  it('consumes the request at every terminal verdict', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    expect(script).toContain('rm -f "$REQUEST"')
    const rejectFn = script.indexOf('reject() {')
    const failFn = script.indexOf('fail() {')
    expect(script.slice(rejectFn, rejectFn + 200)).toContain('rm -f "$REQUEST"')
    expect(script.slice(failFn, failFn + 200)).toContain('rm -f "$REQUEST"')
  })

  it('hashes the decoded sha512 digest bytes against the artifact, not the digest twice', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    // The spooled sha512 is base64 of the raw digest; hashing the decoded bytes
    // through sha512sum again would compare two different layers and never match.
    expect(script).toContain("od -An -v -tx1 | tr -d ' \\n'")
    expect(script).not.toContain('base64 -d 2>/dev/null | sha512sum')
    // The decoded digest must be exactly 128 hex chars before the comparison.
    expect(script).toContain('${#EXPECTED_SHA} -ne 128')
  })

  it('stages the artifact before hashing so the installed bytes are the hashed bytes', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    const cpAt = script.indexOf('cp -- "$ARTIFACT_PATH" "$STAGING"')
    const hashAt = script.indexOf('sha512sum -- "$STAGING"')
    expect(cpAt).toBeGreaterThan(-1)
    expect(hashAt).toBeGreaterThan(cpAt)
    // The later install step must not re-copy from the (mutable) cache path.
    const installSection = script.slice(script.indexOf('systemctl stop "$UNIT_NAME"'))
    expect(installSection).not.toContain('cp -- "$ARTIFACT_PATH"')
  })

  it('echoes the per-attempt attemptId in accepted and ok verdicts', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    expect(script).toContain("ATTEMPT_ID=$(parse_field 'attemptId')")
    const acceptedAt = script.indexOf('{phase: "accepted"')
    const okAt = script.indexOf('{phase: "ok"')
    expect(script.slice(acceptedAt, acceptedAt + 160)).toContain('attemptId')
    expect(script.slice(okAt, okAt + 160)).toContain('attemptId')
    expect(script).not.toContain('runtimeId')
  })

  it('binds rejected and failed verdicts to the attempt so the app can read the real reason', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    const rejectedAt = script.indexOf('{phase: "rejected"')
    const failedAt = script.indexOf('{phase: "failed"')
    expect(rejectedAt).toBeGreaterThan(-1)
    expect(failedAt).toBeGreaterThan(-1)
    expect(script.slice(rejectedAt, rejectedAt + 220)).toContain('attemptId')
    expect(script.slice(rejectedAt, rejectedAt + 220)).toContain('targetVersion')
    expect(script.slice(failedAt, failedAt + 220)).toContain('attemptId')
    expect(script.slice(failedAt, failedAt + 220)).toContain('targetVersion')
  })

  it('writes verdicts through a mktemp path and clears the result under the lock', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    expect(script).toContain('mktemp "$SPOOL_DIR/result.XXXXXXXX"')
    const flockAt = script.indexOf('flock -w 30 9')
    const clearAt = script.indexOf('rm -f "$RESULT"')
    const rootAt = script.indexOf('helper must run as root')
    expect(clearAt).toBeGreaterThan(flockAt)
    expect(clearAt).toBeGreaterThan(rootAt)
  })

  it('fails fast with a verdict when jq or flock are missing', () => {
    const script = buildServeUpdateHelperScript(INPUT)
    expect(script).toContain('command -v jq')
    expect(script).toContain('command -v flock')
    expect(script).toContain('"reason":"jq-missing"')
    expect(script).toContain('"reason":"flock-missing"')
  })
})
