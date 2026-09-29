import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

describe('headless serve shutdown PR gate', () => {
  it('packages Linux artifacts before running the Docker signal oracle', () => {
    const steps = workflow.jobs.package.steps
    const packageStep = steps.find((step) => step.name === 'Package unpacked app')
    const markerStep = steps.find((step) => step.name === 'Verify root-package marker payloads')
    const shutdownStep = steps.find((step) => step.name === 'Verify headless serve signal shutdown')

    expect(workflow.jobs.package['timeout-minutes']).toBe(90)
    expect(packageStep.run).toContain('--linux dir --x64 --publish never')
    expect(packageStep.run).toContain('node config/scripts/package-linux-formats.mjs')
    expect(markerStep.run).toContain('dpkg-deb --fsys-tarfile')
    expect(markerStep.run).toContain('rpm2cpio')
    expect(steps.indexOf(markerStep)).toBeGreaterThan(steps.indexOf(packageStep))
    expect(shutdownStep.run).toBe(
      'node config/scripts/run-headless-serve-shutdown-docker.mjs --appimage dist/orca-linux.AppImage --all-entrypoints'
    )
    expect(steps.indexOf(shutdownStep)).toBeGreaterThan(steps.indexOf(packageStep))
    expect(steps.indexOf(shutdownStep)).toBeGreaterThan(steps.indexOf(markerStep))
    expect(
      steps.filter((step) => step.run?.includes('run-headless-serve-shutdown-docker.mjs'))
    ).toHaveLength(1)
  })
})
