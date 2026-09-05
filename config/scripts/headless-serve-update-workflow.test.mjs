import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const updateCase = readFileSync('config/docker/headless-serve-update/run-update-case.sh', 'utf8')
const updateRunner = readFileSync('config/scripts/run-headless-serve-update-docker.mjs', 'utf8')
const updateDockerfile = readFileSync('config/docker/headless-serve-update/Dockerfile', 'utf8')
const helperScriptSource = readFileSync('src/main/cli/serve-update-helper-script.ts', 'utf8')
const installerSource = readFileSync('src/main/cli/serve-update-helper-installer.ts', 'utf8')

// The generated helper script itself is covered by src/main/cli/serve-update-helper-script.test.ts.
// This gate pins the E2E plumbing: the case script must exercise the real handshake,
// the runner must be privileged + cgroup-host for systemd, and CI must wire both in.
describe('headless serve update PR gate', () => {
  it('runs the update case after packaging in the package job', () => {
    const steps = workflow.jobs.package.steps
    const updateStep = steps.find((step) => step.name === 'Verify headless serve update flow')
    expect(updateStep).toBeDefined()
    expect(updateStep.run).toBe(
      'node config/scripts/run-headless-serve-update-docker.mjs --appimage dist/orca-linux.AppImage'
    )
    const packageStep = steps.find((step) => step.name === 'Package unpacked app')
    expect(steps.indexOf(updateStep)).toBeGreaterThan(steps.indexOf(packageStep))
  })

  it('runs the container with systemd requirements', () => {
    expect(updateRunner).toContain("'--privileged'")
    expect(updateRunner).toContain("'--cgroupns=host'")
    expect(updateRunner).toContain("'/sys/fs/cgroup:/sys/fs/cgroup:rw'")
    expect(updateRunner).toContain('ORCA_UPDATE_TIMEOUT')
    expect(updateRunner).toContain('ORCA_READINESS_TIMEOUT')
    expect(updateDockerfile).toContain('systemd')
    expect(updateDockerfile).toContain('ENTRYPOINT ["/usr/local/bin/run-update-case"]')
  })

  it('exercises the full spool handshake in the case script', () => {
    // request spool -> helper -> verdict. The helper runs as root via the service
    // user's sudoers rule, exactly the way updater-serve-install-handoff launches it.
    expect(updateCase).toContain('request.json')
    expect(updateCase).toContain('runuser -u "$SERVICE_USER" -- sudo -n "$HELPER_PATH"')
    expect(updateCase).toContain("'.phase'")
    // swap + VERSION + restart + readiness
    expect(updateCase).toContain('/opt/orca/VERSION')
    expect(updateCase).toContain('systemctl start')
    expect(updateCase).toContain('MainPID')
    // negative case
    expect(updateCase).toContain('downgrade')
  })

  it('installs the helper from the runner-generated installer, not a hand-copied copy', () => {
    // The runner bundles the real installer and mounts it where the case script expects it.
    expect(updateRunner).toContain('buildServeUpdateHelperInstallScript')
    expect(updateRunner).toContain('/tmp/helper-install.sh')
    expect(updateCase).toContain('bash /tmp/helper-install.sh')
    expect(updateRunner).toContain('buildSync({')
    expect(updateRunner).toContain('serve-update-helper-installer.ts')
  })

  it('keeps helper output contract in sync with the spool schema', () => {
    for (const token of ['"phase":"accepted"', '"phase":"ok"', '"phase":"rejected"']) {
      expect(helperScriptSource).toContain(token)
    }
    expect(installerSource).toContain('helperVersion')
  })
})
