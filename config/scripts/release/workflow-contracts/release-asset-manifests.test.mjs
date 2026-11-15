// Every job that uploads desktop release assets records exactly what it uploaded, before anything is published.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { PUBLISH_GATES } from '../publication/verify-prior-run-provenance.mjs'
import { buildManifest, MANIFEST_SCHEMA } from '../publication/write-release-asset-manifest.mjs'

const releaseCutText = readFileSync('.github/workflows/release-cut.yml', 'utf8')
const releaseCut = parse(releaseCutText)
const macBuildText = readFileSync('.github/workflows/release-mac-build.yml', 'utf8')
const macBuild = parse(macBuildText)
const WRITER = 'config/scripts/release/publication/write-release-asset-manifest.mjs'
const PINNED = /^actions\/[\w-]+@[0-9a-f]{40}$/

// Fails on a missing step, so an order check can never pass against -1.
const stepIndex = (steps, name) => {
  const index = steps.findIndex((step) => step.name === name)
  expect(index, name).toBeGreaterThanOrEqual(0)
  return index
}
const FINAL_CHECKS = [
  'Verify release remains draft after artifact upload',
  'Verify telemetry constants present in app.asar'
]

describe('release asset manifests', () => {
  it('records Linux, source map and Windows uploads after they happen, Windows on attempt 1 only', () => {
    const steps = releaseCut.jobs.build.steps
    const record = steps[stepIndex(steps, 'Record the uploaded release assets')]
    const upload = steps[stepIndex(steps, 'Upload the release asset manifest')]
    for (const uploader of [
      'Publish main-process source maps',
      'Publish release artifacts (Linux)',
      'Publish signed Windows release artifacts'
    ]) {
      expect(stepIndex(steps, uploader)).toBeLessThan(steps.indexOf(record))
    }
    // The re-draft safety check runs even if recording fails, and a run failing a final check leaves no manifest.
    for (const check of FINAL_CHECKS) {
      expect(stepIndex(steps, check), check).toBeLessThan(steps.indexOf(record))
    }
    expect(steps.indexOf(record)).toBeGreaterThanOrEqual(0)
    expect(steps.indexOf(upload)).toBe(steps.indexOf(record) + 1)
    expect(record.run).toContain(`node ${WRITER}`)
    expect(record.run).toContain(
      'files=(dist/orca-windows-setup.exe dist/orca-windows-setup.exe.blockmap dist/latest.yml)'
    )
    expect(record.run).toContain('files=(dist/*.AppImage dist/*.deb dist/*.rpm dist/*-linux*.yml)')
    expect(record.run).toContain('"$RUNNER_TEMP/orca-sourcemaps-$TAG.zip"')
    for (const step of [record, upload]) {
      expect(step.if).toBe("matrix.platform != 'win' || github.run_attempt == 1")
    }
    expect(upload.uses).toMatch(PINNED)
    expect(upload.with).toMatchObject({
      name: 'release-asset-manifest-${{ matrix.platform }}',
      overwrite: "${{ matrix.platform != 'win' }}"
    })
    // The release checkout may predate the writer, so it is restored from the workflow commit.
    expect(
      steps[stepIndex(steps, 'Restore draft-publish scripts from the workflow ref')].run
    ).toContain(WRITER)
  })

  it('records the macOS uploads after the minimum-macOS gate rewrites the update manifest', () => {
    const steps = macBuild.jobs['build-mac'].steps
    const record = stepIndex(steps, 'Record the uploaded release assets')
    expect(stepIndex(steps, 'Gate the update manifest on the minimum macOS')).toBeLessThan(record)
    for (const check of FINAL_CHECKS) {
      expect(stepIndex(steps, check), check).toBeLessThan(record)
    }
    expect(steps[record].run).toContain(
      'dist/*.dmg dist/*.dmg.blockmap dist/*.zip dist/*.zip.blockmap dist/*-mac.yml'
    )
    expect(steps[record].env.RELEASE_SHA).toBe('${{ inputs.release_sha }}')
    const upload = steps[record + 1]
    expect(upload.uses).toMatch(PINNED)
    expect(upload.with.name).toBe('release-asset-manifest-mac')
    expect(
      steps[stepIndex(steps, 'Restore draft-publish scripts from the workflow ref')].run
    ).toContain(WRITER)
  })

  it('uploads the orca-server tarballs before publish, and publish waits for them', () => {
    expect(releaseCut.jobs['publish-orca-server-artifact']).toBeUndefined()
    const job = releaseCut.jobs['upload-orca-server-artifact']
    expect(job.needs).not.toContain('publish-release')
    expect(job.needs).toContain('create-release')
    for (const step of job.steps.filter((s) => s.uses)) {
      expect(step.uses).toMatch(PINNED)
    }
    expect(job.steps[0].with).toMatchObject({
      ref: '${{ github.workflow_sha }}',
      'persist-credentials': false
    })
    expect(job.steps.at(-1).with.name).toBe('release-asset-manifest-orca-server')
    const publish = releaseCut.jobs['publish-release']
    expect(publish.needs).toContain('upload-orca-server-artifact')
    // A packing failure skips the upload and the release ships without tarballs; an upload failure holds it.
    expect(publish.if).toContain(
      "(needs.upload-orca-server-artifact.result == 'success' || needs.upload-orca-server-artifact.result == 'skipped')"
    )
  })
})

describe('publish-release asset provenance', () => {
  const job = releaseCut.jobs['publish-release']
  const ids = job.steps.map((step) => step.id ?? step.name)
  const verify = job.steps[ids.indexOf('Verify every draft asset matches its build manifest')]

  it('verifies every draft asset against this run and the macOS run before minting the App token', () => {
    expect(ids.indexOf(verify.name)).toBeLessThan(ids.indexOf('release-app-token'))
    expect(job.permissions).toEqual({ contents: 'write', actions: 'read' })
    expect(verify.run).toContain(
      'node config/scripts/release/publication/verify-release-asset-provenance.mjs'
    )
    expect(verify.env).toMatchObject({
      MAC_RUN_ID: '${{ needs.build-mac.outputs.run_id }}',
      MAC_RUN_ATTEMPT: '${{ needs.build-mac.outputs.run_attempt }}',
      ORCA_SERVER: "${{ needs.upload-orca-server-artifact.result == 'success' }}"
    })
    const downloads = job.steps.filter((step) => step.uses?.startsWith('actions/download-artifact'))
    expect(downloads.map((step) => step.with)).toEqual([
      { pattern: 'release-asset-manifest-*', path: '${{ runner.temp }}/asset-manifests/run' },
      {
        name: 'release-asset-manifest-mac',
        path: '${{ runner.temp }}/asset-manifests/mac',
        'run-id': '${{ needs.build-mac.outputs.run_id }}',
        'github-token': '${{ secrets.GITHUB_TOKEN }}'
      }
    ])
    for (const step of downloads) {
      expect(step.uses).toMatch(PINNED)
      expect(ids.indexOf(step.name)).toBeLessThan(ids.indexOf(verify.name))
    }
  })
})

describe('write-release-asset-manifest', () => {
  let dir
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
  const file = (name, body) => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }
  const base = {
    source: 'win',
    tag: 'v1.2.3',
    releaseSha: 'a'.repeat(40),
    runId: '7',
    runAttempt: '1'
  }

  it('records each uploaded file by name, size and sha256', async () => {
    dir = mkdtempSync(join(tmpdir(), 'asset-manifest-'))
    const files = [file('orca-windows-setup.exe', 'exe'), file('latest.yml', 'version: 1.2.3\n')]
    const manifest = await buildManifest({ ...base, files })
    expect(manifest).toEqual({
      schema: MANIFEST_SCHEMA,
      source: 'win',
      tag: 'v1.2.3',
      release_sha: 'a'.repeat(40),
      run_id: '7',
      run_attempt: '1',
      assets: [
        {
          name: 'orca-windows-setup.exe',
          size: 3,
          sha256: createHash('sha256').update('exe').digest('hex')
        },
        {
          name: 'latest.yml',
          size: 15,
          sha256: createHash('sha256').update('version: 1.2.3\n').digest('hex')
        }
      ]
    })
  })

  it.each([
    ['an empty file', () => [file('latest.yml', '')]],
    ['no files', () => []],
    ['a duplicate name', () => [file('latest.yml', 'a'), join(dir, '.', 'latest.yml')]],
    ['a name the verifier would reject', () => [file('.hidden', 'a')]]
  ])('refuses %s', async (_name, files) => {
    dir = mkdtempSync(join(tmpdir(), 'asset-manifest-'))
    await expect(buildManifest({ ...base, files: files() })).rejects.toThrow()
  })

  it('refuses an unknown source', async () => {
    dir = mkdtempSync(join(tmpdir(), 'asset-manifest-'))
    await expect(
      buildManifest({ ...base, source: 'evil', files: [file('a.yml', 'a')] })
    ).rejects.toThrow(/Unknown manifest source/)
  })
})

// A leftover draft must pass exactly the gates publish-release demands, never fewer.
describe('prior-run auto-publish gates', () => {
  const publish = releaseCut.jobs['publish-release']
  const condition = publish.if.replace(/\s+/g, ' ')
  // The job names a gate job appears under in the jobs API, and the legs it may fail on.
  function derive(id) {
    const job = releaseCut.jobs[id]
    const legs = job.strategy?.matrix?.include
    if (!legs) {
      expect(job['continue-on-error'], id).toBeUndefined()
      return { names: [job.name ?? id], tolerated: [] }
    }
    if (job.name === undefined) {
      expect(job['continue-on-error'], id).toBeUndefined()
      return { unnamedLegs: legs.length }
    }
    const tolerated = String(job['continue-on-error'] ?? '').match(
      /^\$\{\{ matrix\.platform == '([\w-]+)' \}\}$/
    )?.[1]
    if (job['continue-on-error'] !== undefined) {
      expect(tolerated, `${id} continue-on-error`).toBeDefined()
    }
    const suffix = ' ${{ matrix.platform }}'
    expect(job.name.endsWith(suffix), id).toBe(true)
    const name = (leg) => `${job.name.slice(0, -suffix.length)} ${leg.platform}`
    return {
      names: legs.filter((leg) => leg.platform !== tolerated).map(name),
      tolerated: legs.filter((leg) => leg.platform === tolerated).map(name)
    }
  }

  it('covers every job publish-release needs, as its if: requires them', () => {
    const gated = PUBLISH_GATES.map((gate) => gate.job)
    expect([...gated, 'upload-orca-server-artifact'].sort()).toEqual([...publish.needs].sort())
    for (const job of gated) {
      expect(condition).toContain(`needs.${job}.result == 'success'`)
    }
    expect(condition).toContain(
      "(needs.upload-orca-server-artifact.result == 'success' || needs.upload-orca-server-artifact.result == 'skipped')"
    )
  })

  it.each(PUBLISH_GATES.map((gate) => [gate.job, gate]))(
    'requires %s under the names and tolerated failures the workflow defines',
    (id, gate) => {
      const derived = derive(id)
      if (derived.unnamedLegs !== undefined) {
        expect(gate).toEqual({ job: id, prefix: `${id} (`, count: derived.unnamedLegs })
        return
      }
      expect(gate.names).toEqual(derived.names)
      expect(gate.tolerated ?? []).toEqual(derived.tolerated)
    }
  )
})
