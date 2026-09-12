import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

const readWorkflow = (relativePath) => parse(readFileSync(join(projectDir, relativePath), 'utf8'))

// Every step that mirrors this repo's whole ref namespace onto a runner disk to
// prove a commit is reachable from a branch or tag before signing it.
const REF_MIRRORS = [
  ['.github/workflows/adhoc-mac-build.yml', 'build-adhoc-mac', 'Vet the requested ref'],
  ['.github/workflows/dev-channel-win-build.yml', 'build-win', 'Vet the requested inputs']
]

describe('ref-mirroring vet steps', () => {
  it('keeps the full-history adhoc checkout on the same case-safe backend', () => {
    const steps = readWorkflow('.github/workflows/adhoc-mac-build.yml').jobs['build-adhoc-mac']
      .steps
    const checkout = steps.find((step) => step.name === 'Checkout the requested ref')
    expect(checkout.env.GIT_DEFAULT_REF_FORMAT).toBe('reftable')
    expect(checkout.with.ref).toBe('${{ steps.vetted.outputs.sha }}')
    expect(checkout.with['fetch-depth']).toBe(0)
    expect(checkout.with['persist-credentials']).toBe(false)
  })

  // Why: macOS and Windows runner disks are case-insensitive, and this repo has
  // branches that differ only in casing. The files backend cannot store both, and
  // it fails the whole fetch rather than the one ref — so the vet step dies before
  // any build runs. reftable keys refs in a table instead of file paths.
  it.each(REF_MIRRORS)(
    '%s creates its scratch repo with the reftable backend',
    (path, job, step) => {
      const run = readWorkflow(path).jobs[job].steps.find(
        (candidate) => candidate.name === step
      ).run

      expect(run).toContain('+refs/heads/*:refs/heads/*')
      expect(run).toMatch(/git init\b[^\n]*--ref-format=reftable/)
      expect(run).not.toMatch(/git init -q --bare "\$scratch"/)
    }
  )
})
