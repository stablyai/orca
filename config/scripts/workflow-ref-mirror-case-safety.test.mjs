import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '../../src/shared/child-process/run-process'

const projectDir = resolve(import.meta.dirname, '../..')

const readWorkflow = (relativePath) => parse(readFileSync(join(projectDir, relativePath), 'utf8'))

// Every step that mirrors this repo's whole ref namespace onto a runner disk to
// prove a commit is reachable from a branch or tag before signing it.
const REF_MIRRORS = [
  ['.github/workflows/adhoc-mac-build.yml', 'build-adhoc-mac', 'Vet the requested ref'],
  ['.github/workflows/dev-channel-win-build.yml', 'build-win', 'Vet the requested inputs']
]

describe('ref-mirroring vet steps', () => {
  it.each(['daily', 'hourly', 'adhoc'])('%s builds only need the current commit', (channel) => {
    const job = readWorkflow(`.github/workflows/${channel}-mac-build.yml`).jobs[
      `build-${channel}-mac`
    ]
    const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v6')
    expect(checkout.with['fetch-depth']).toBe(1)
    expect(job.steps.some((step) => step.run?.includes('gh release list'))).toBe(true)
    expect(
      job.steps.some((step) => step.run?.includes('ORCA_PUBLISHED_VERSIONS="$published"'))
    ).toBe(true)
  })

  it('retains release-cut history for version reservation and retry ancestry', () => {
    const checkout = readWorkflow('.github/workflows/release-cut.yml').jobs.cut.steps.find(
      (step) => step.uses === 'actions/checkout@v6'
    )
    expect(checkout.with['fetch-depth']).toBe(0)
  })

  it('resolves identical dev identities in full and depth-one checkouts without local tags', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-checkout-identity-'))
    const source = join(directory, 'source')
    const shallow = join(directory, 'shallow')
    const run = (program, args, cwd) => {
      const result = runProcessSync({ program, args, cwd })
      expect(result.code, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    const git = (args, cwd = directory) => run('git', args, cwd)
    try {
      git(['init', source])
      git(['config', 'user.name', 'CI test'], source)
      git(['config', 'user.email', 'ci@example.invalid'], source)
      writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '1.4.165-rc.0' }))
      git(['add', 'package.json'], source)
      git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'], source)
      git(['tag', 'v1.4.167'], source)
      git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'head'], source)
      git(['clone', '--depth=1', '--no-tags', pathToFileURL(source).href, shallow])
      expect(git(['rev-list', '--count', 'HEAD'], shallow)).toBe('1')
      expect(git(['tag', '--list'], shallow)).toBe('')
      const script = `
        const result = [];
        for (const [channel, exported] of [['daily', 'Daily'], ['hourly', 'Hourly'], ['adhoc', 'Adhoc']]) {
          const module = await import(${JSON.stringify(pathToFileURL(join(projectDir, 'config/scripts/')).href)} + channel + '-build-version.mjs');
          const date = new Date('2026-09-12T00:00:00Z');
          result.push(channel === 'adhoc'
            ? module.getAdhocBuildIdentity(date, 'branch', ['v1.4.167'])
            : module['get' + exported + 'BuildIdentity'](date, { publishedVersions: ['v1.4.167'], releaseNames: [] }));
        }
        process.stdout.write(JSON.stringify(result));
      `
      const identities = (cwd) => run(process.execPath, ['--input-type=module', '-e', script], cwd)
      expect(identities(shallow)).toBe(identities(source))
      expect(
        JSON.parse(identities(shallow)).every((identity) => identity.version.startsWith('1.4.168-'))
      ).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('checks out only the vetted commit without remirroring refs', () => {
    const steps = readWorkflow('.github/workflows/adhoc-mac-build.yml').jobs['build-adhoc-mac']
      .steps
    const checkout = steps.find((step) => step.name === 'Checkout the requested ref')
    expect(checkout.with.ref).toBe('${{ steps.vetted.outputs.sha }}')
    expect(checkout.with['fetch-depth']).toBe(1)
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
