import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const headlessLinuxGuide = readFileSync('docs/reference/headless-linux-server.md', 'utf8')
const signalCase = readFileSync('config/docker/headless-serve-shutdown/run-signal-case.sh', 'utf8')
const shutdownDockerRunner = readFileSync(
  'config/scripts/run-headless-serve-shutdown-docker.mjs',
  'utf8'
)
const shutdownDockerfile = readFileSync('config/docker/headless-serve-shutdown/Dockerfile', 'utf8')
const desktopStartupOracle = readFileSync(
  'config/docker/headless-serve-shutdown/run-appimage-desktop-startup-case.sh',
  'utf8'
)
const headlessLinuxProse = headlessLinuxGuide.replace(/\s+/g, ' ')

function readSystemdUnitBlocks(doc, unitName) {
  const escapedUnitName = unitName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...doc.matchAll(new RegExp(`^# /etc/systemd/system/${escapedUnitName}$`, 'gm'))].map(
    (match) => {
      const start = match.index + match[0].length
      const end = doc.indexOf('```', start)
      const nextUnitHeaderOffset = doc.slice(start).search(/^# \/etc\/systemd\/system\/.+$/m)
      const nextUnitHeader = nextUnitHeaderOffset === -1 ? -1 : start + nextUnitHeaderOffset
      if (end === -1 || (nextUnitHeader !== -1 && end > nextUnitHeader)) {
        throw new Error(`Missing closing code fence for ${unitName}`)
      }
      return doc.slice(start, end)
    }
  )
}

describe('headless serve shutdown PR gate', () => {
  it('reads only exact, closed systemd unit blocks', () => {
    expect(
      readSystemdUnitBlocks('# /etc/systemd/system/orca-serveXservice\n```', 'orca-serve.service')
    ).toEqual([])
    expect(() =>
      readSystemdUnitBlocks('# /etc/systemd/system/orca-serve.service\n', 'orca-serve.service')
    ).toThrow('Missing closing code fence for orca-serve.service')
    expect(() =>
      readSystemdUnitBlocks(
        '# /etc/systemd/system/orca-serve.service\n' +
          'KillMode=mixed\n' +
          '# /etc/systemd/system/other.service\n```',
        'orca-serve.service'
      )
    ).toThrow('Missing closing code fence for orca-serve.service')
  })

  it('packages Linux artifacts before running the Docker signal oracle', () => {
    const steps = workflow.jobs.package.steps
    const packageStep = steps.find((step) => step.name === 'Package unpacked app')
    const markerStep = steps.find((step) => step.name === 'Verify root-package marker payloads')
    const shutdownStep = steps.find((step) => step.name === 'Verify headless serve signal shutdown')
    const launcherShutdownStep = steps.find(
      (step) => step.name === 'Verify extracted launcher serve signal shutdown'
    )
    const appImageShutdownStep = steps.find(
      (step) => step.name === 'Verify AppImage CLI registration and serve signal shutdown'
    )

    expect(workflow.jobs.package['timeout-minutes']).toBe(90)
    expect(packageStep.run).toContain('--linux AppImage deb rpm --x64 --publish never')
    expect(markerStep.run).toContain('dpkg-deb --fsys-tarfile')
    expect(markerStep.run).toContain('rpm2cpio')
    expect(steps.indexOf(markerStep)).toBeGreaterThan(steps.indexOf(packageStep))
    expect(shutdownStep.run).toBe(
      'node config/scripts/run-headless-serve-shutdown-docker.mjs --appimage dist/orca-linux.AppImage'
    )
    expect(launcherShutdownStep.run).toContain(
      'node config/scripts/run-headless-serve-shutdown-docker.mjs'
    )
    expect(launcherShutdownStep.run).toContain('--entrypoint launcher')
    expect(appImageShutdownStep.run).toContain('--entrypoint appimage')
    expect(appImageShutdownStep.run).toContain('--signal-target serving-electron')
    expect(appImageShutdownStep.run).toContain('--int-delivery pid')
    expect(steps.indexOf(shutdownStep)).toBeGreaterThan(steps.indexOf(packageStep))
    expect(steps.indexOf(shutdownStep)).toBeGreaterThan(steps.indexOf(markerStep))
    expect(steps.indexOf(launcherShutdownStep)).toBeGreaterThan(steps.indexOf(shutdownStep))
    expect(steps.indexOf(appImageShutdownStep)).toBeGreaterThan(steps.indexOf(launcherShutdownStep))
  })

  it('keeps readiness polling finite and leak-free', () => {
    expect(signalCase).toContain('read_ready_line()')
    expect(signalCase).toContain("sed -u -n 's/^[^{]*//p'")
    expect(signalCase).toContain('startup_timeout_seconds=${ORCA_STARTUP_TIMEOUT_SECONDS:-180}')
    expect(signalCase).toContain('startup_deadline=$((SECONDS + startup_timeout_seconds))')
    expect(signalCase).toContain('while (( SECONDS < startup_deadline )); do')
    expect(signalCase).toContain('kill -0 "$app_pid" 2>/dev/null || break')
    expect(signalCase).toContain(
      "jq's `inputs` waits for EOF even when wrapped in `first`, so a tail -F"
    )
    expect(signalCase).not.toContain('tail --pid=')
  })

  it('gives owned shutdown state a bounded cleanup grace', () => {
    expect(signalCase).toContain('for shutdown_poll in {0..50}; do')
    expect(signalCase).toContain('[[ -z "$listener_after" && -z "$owned_residue" ]]')
    expect(signalCase).toContain('((${#survivors[@]} == 0))')
    expect(signalCase).toContain('((shutdown_poll < 50)) && sleep 0.1')
  })

  it('checks that a serving-electron signal target owns the ready socket', () => {
    const ssRecord =
      'LISTEN 0 128 127.0.0.1:41235 0.0.0.0:* users:(("orca-ide",pid=23,fd=7),("orca-ide",pid=25,fd=8))'
    expect([...ssRecord.matchAll(/pid=([0-9]+)/g)].map((match) => match[1])).toEqual(['23', '25'])
    expect(signalCase).toContain(
      'listener_before_pids=$(grep -oE \'pid=[0-9]+\' <<<"$listener_before" | cut -d= -f2 || true)'
    )
    expect(signalCase).toContain('signal_target_pid=$(head -n1 <<<"$listener_before_pids")')
    expect(signalCase).toContain('outside the entrypoint process tree')
  })

  it('runs the original AppImage desktop startup oracle before extraction and signals', () => {
    expect(shutdownDockerfile).toContain(
      'COPY run-appimage-desktop-startup-case.sh /usr/local/bin/run-appimage-desktop-startup-case'
    )
    const startupCall = shutdownDockerRunner.indexOf(
      'runDesktopStartupOracle({ image, appImage, platform })'
    )
    const extractionCall = shutdownDockerRunner.indexOf(
      "'timeout --kill-after=10s 120s /input/orca.AppImage --appimage-extract"
    )
    const signalLoop = shutdownDockerRunner.indexOf("for (const signal of ['INT', 'TERM'])")
    expect(startupCall).toBeGreaterThan(-1)
    expect(extractionCall).toBeGreaterThan(startupCall)
    expect(signalLoop).toBeGreaterThan(startupCall)
    expect(shutdownDockerRunner).toContain("'/usr/local/bin/run-appimage-desktop-startup-case'")
  })

  it('preserves startup logs when the launcher exits before its marker', () => {
    expect(desktopStartupOracle).toContain('signal_process_group TERM || true')
    expect(desktopStartupOracle).toContain('signal_process_group KILL || true')
    expect(desktopStartupOracle).toContain('cat "$stdout_log" >&2 2>/dev/null || true')
    expect(desktopStartupOracle).toContain('cat "$stderr_log" >&2 2>/dev/null || true')
    expect(desktopStartupOracle).toContain(
      'FAIL: desktop launcher exited before ${reason} (status=${observed_status})'
    )
    expect(desktopStartupOracle).toContain('ORCA_STARTUP_STATE_DIR_CLEANUP=1')
    expect(desktopStartupOracle).toContain(
      '[[ "$state_dir" =~ ^/tmp/orca-appimage-startup\\.[^/]+$ ]] || return 0'
    )
  })

  it('requires the bound AppImage to be executable before launch and extraction', () => {
    expect(desktopStartupOracle).toContain(
      '[[ -x "$appimage" ]] || { echo "FAIL: AppImage is not executable: $appimage" >&2; exit 1; }'
    )
    expect(shutdownDockerRunner).toContain(
      '\'test -r /input/orca.AppImage && test -x /input/orca.AppImage || { echo "FAIL: AppImage bind must be readable and executable" >&2; exit 1; }\''
    )
  })

  it('gives the original AppImage enough bounded extraction space', () => {
    expect(shutdownDockerRunner).toContain("'/tmp:rw,nosuid,nodev,exec,size=1g'")
  })

  it('keeps owned Xvfb alive during the documented systemd graceful stop', () => {
    const serveUnits = readSystemdUnitBlocks(headlessLinuxGuide, 'orca-serve.service')
    const ownedXvfbUnits = serveUnits.filter((unit) => !/^Environment=DISPLAY=/m.test(unit))
    const managedXvfbUnits = serveUnits.filter((unit) => /^Environment=DISPLAY=/m.test(unit))

    expect(ownedXvfbUnits).toHaveLength(1)
    expect(ownedXvfbUnits[0]).toMatch(/^ExecStart=.*orca-linux\.AppImage serve.*$/m)
    expect(ownedXvfbUnits[0]).toMatch(/^KillMode=mixed$/m)
    expect(managedXvfbUnits).toHaveLength(1)
    expect(managedXvfbUnits[0]).not.toMatch(/^KillMode=/m)
  })

  it('distinguishes persisted state from live work during a service restart', () => {
    expect(headlessLinuxProse).toContain(
      'Every `systemctl stop` or `restart` therefore ends live terminals and agent processes'
    )
    expect(headlessLinuxProse).toContain(
      'These guarantees do not preserve live processes. The service restart kills every terminal and agent in its cgroup'
    )
    expect(headlessLinuxProse).toContain(
      'A separately paired runtime is outside that boundary; local execution and SSH hosts reached through this runtime are not. An affected or unknown omission, missing scope, failed request or lost connection is `unverifiable`'
    )
    expect(headlessLinuxGuide).toContain(
      'sudo -Hu orca /home/orca/.local/bin/orca-ide terminal list --json'
    )
    expect(headlessLinuxGuide).not.toContain('sudo -Hu orca orca-ide terminal list --json')
    expect(headlessLinuxGuide).not.toContain('Two facts make this safe and predictable')
  })

  it('uses the registered CLI name from ordinary Linux shells', () => {
    const commandRule =
      'The registered Linux CLI command is `orca-ide`, not `orca`, to avoid shadowing the GNOME Orca screen reader.'
    const substitutionRule =
      "From an ordinary shell outside that service user's managed environment, substitute `orca-ide` for `orca` in commands below."
    const censusCommand = '`sudo -Hu orca /home/orca/.local/bin/orca-ide terminal list --json`'

    expect(headlessLinuxProse).toContain(commandRule)
    expect(headlessLinuxProse).toContain(substitutionRule)
    expect(headlessLinuxProse).toContain(censusCommand)
    expect(headlessLinuxGuide).toContain('best-effort dispatcher at `$HOME/.local/bin/orca`')
    expect(headlessLinuxProse.indexOf(substitutionRule)).toBeLessThan(
      headlessLinuxProse.indexOf(censusCommand)
    )
  })
})
