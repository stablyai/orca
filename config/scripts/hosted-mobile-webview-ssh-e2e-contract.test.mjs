import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const SPEC = 'tests/e2e/hosted-mobile-webview-ssh.spec.ts'

// Why: no GitHub runner offers an iOS simulator and a Docker daemon, so this spec is
// manual-only. Pin the facts that keep "unrun" honest rather than leaving them in a YAML
// comment: it is excluded from the lane that would report a green skip, it has a named
// manual entry point, and it refuses to run itself when either prerequisite is missing.
describe('hosted mobile WebView SSH e2e contract', () => {
  const spec = readFileSync(join(projectDir, SPEC), 'utf8')

  it('stays out of the changed-spec lane that cannot run it', () => {
    const workflow = parseYaml(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))
    const changedRun = workflow.jobs['changed-e2e'].steps.find(
      (step) => step.name === 'Run changed E2E specs'
    )

    expect(changedRun.run).toContain(`. != "${SPEC}"`)
  })

  it('keeps a named manual entry point for both the dev and packaged runs', () => {
    const scripts = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).scripts

    expect(scripts['test:e2e:hosted-mobile-webview:ssh']).toContain(
      'run-hosted-mobile-webview-ssh-e2e.mjs'
    )
    expect(scripts['test:e2e:hosted-mobile-webview:ssh:packaged']).toContain(
      'run-packaged-hosted-mobile-webview-ssh-e2e.mjs'
    )
  })

  it('refuses to run itself without a Docker daemon or macOS', () => {
    expect(spec).toContain(
      "test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')"
    )
    expect(spec).toContain(
      "test.skip(process.platform !== 'darwin', 'Hosted iOS WebView automation requires macOS.')"
    )
  })
})
