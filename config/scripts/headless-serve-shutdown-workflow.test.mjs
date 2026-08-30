import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const headlessLinuxGuide = readFileSync('docs/reference/headless-linux-server.md', 'utf8')
const signalCase = readFileSync('config/docker/headless-serve-shutdown/run-signal-case.sh', 'utf8')

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

  it('packages an x64 AppImage before running the Docker signal oracle', () => {
    const steps = workflow.jobs.package.steps
    const packageStep = steps.find((step) => step.name === 'Package unpacked app')
    const shutdownStep = steps.find((step) => step.name === 'Verify headless serve signal shutdown')
    const launcherShutdownStep = steps.find(
      (step) => step.name === 'Verify extracted launcher serve signal shutdown'
    )
    const appImageShutdownStep = steps.find(
      (step) => step.name === 'Verify AppImage CLI registration and serve signal shutdown'
    )

    expect(packageStep.run).toContain('--linux AppImage --x64 --publish never')
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
    expect(steps.indexOf(launcherShutdownStep)).toBeGreaterThan(steps.indexOf(shutdownStep))
    expect(steps.indexOf(appImageShutdownStep)).toBeGreaterThan(steps.indexOf(launcherShutdownStep))
  })

  it('keeps the readiness parser line-buffered', () => {
    expect(signalCase).toContain("| sed -u -n 's/^[^{]*//p'")
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
})
