import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { createDraftRelease } from './create-draft-release.mjs'

// Actual v1.4.259 shape: app source 1d35… is the sole parent of release commit 980c…, tag object d272….
const source = '1d3548fb8bf2794b218affefc103d9b2a956220f'
const checkout = '980c0024741812bd7ae934c0c22144d9926a784e'
const tagObject = 'd2720cd6c86fdf95230bdcb6778abe0f7c061ace'
const tag = 'v1.4.259'
const draft = { id: 259, draft: true, tag_name: tag, body: 'original notes' }

function fixture(options = {}) {
  const writes = []
  const reads = []
  let wrote = false
  const response = (body, status = 200) => ({
    ok: status === 200,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: async () => body,
    text: async () => JSON.stringify(body)
  })
  const fetchImpl = async (url, request = {}) => {
    const route = url.replace('https://api.github.com/repos/test/repo', '')
    const method = request.method ?? 'GET'
    reads.push(route)
    if (route === `/git/ref/tags/${tag}`) {
      if (options.missing || (wrote && options.deleted)) {
        return response({}, 404)
      }
      const sha = wrote && options.moved ? 'e'.repeat(40) : options.annotated ? tagObject : checkout
      return response({
        ref: `refs/tags/${tag}`,
        object: { type: options.annotated ? 'tag' : 'commit', sha }
      })
    }
    if (route === `/git/tags/${tagObject}`) {
      return response({
        sha: tagObject,
        object: { type: 'commit', sha: options.commit ?? checkout }
      })
    }
    if (route.startsWith('/git/commits/')) {
      const sha = route.slice('/git/commits/'.length)
      return response({ sha, parents: (options.parents ?? [source]).map((p) => ({ sha: p })) })
    }
    if (route === '') {
      return response({ default_branch: 'main' })
    }
    if (route.startsWith('/releases?')) {
      return response(options.listed ?? (options.existing ? [draft] : []))
    }
    if (route === '/releases/generate-notes') {
      return response({ body: 'new notes', name: 'release' })
    }
    if (route === '/releases/259' && method === 'GET') {
      return response(wrote ? (options.afterPatch ?? draft) : (options.beforePatch ?? draft))
    }
    if (method === 'POST' || method === 'PATCH') {
      writes.push({ method, route, body: JSON.parse(request.body) })
      wrote = true
      return response(options.writeResult ?? { ...draft, body: JSON.parse(request.body).body })
    }
    if (route === '/releases') {
      return response(options.visible ?? [draft])
    }
    throw new Error(`Unexpected request ${method} ${route}`)
  }
  return {
    writes,
    reads,
    run: () =>
      createDraftRelease({
        repo: 'test/repo',
        tag,
        token: 'fixture-token',
        targetCommitish: checkout,
        sourceSha: options.approvedSource ?? source,
        fetchImpl,
        sleep: async () => {},
        log: () => {}
      })
  }
}

describe('release draft source and uploader contract', () => {
  it.each([false, true])(
    'drafts the existing tag with default-branch metadata (annotated=%s)',
    async (annotated) => {
      const f = fixture({ annotated })
      await expect(f.run()).resolves.toEqual({
        tagObject: annotated ? tagObject : checkout,
        releaseSha: checkout
      })
      expect(f.writes).toEqual([
        {
          method: 'POST',
          route: '/releases',
          body: {
            tag_name: tag,
            target_commitish: 'main',
            name: 'release',
            body: 'new notes',
            draft: true,
            prerelease: false,
            make_latest: 'false'
          }
        }
      ])
    }
  )

  it('peels the captured tag object ID instead of re-dereferencing the tag name', async () => {
    const f = fixture({ annotated: true })
    await f.run()
    expect(f.reads).toContain(`/git/tags/${tagObject}`)
    expect(f.reads).toContain(`/git/commits/${checkout}`)
    expect(f.reads.some((route) => route.startsWith('/commits/'))).toBe(false)
  })

  it.each([
    { missing: true },
    { annotated: true, commit: 'e'.repeat(40) },
    { parents: ['e'.repeat(40)] },
    { parents: [source, 'e'.repeat(40)] },
    { approvedSource: 'short' }
  ])('refuses an absent, mismatched or unauthorized tag before writing: %j', async (options) => {
    const f = fixture(options)
    await expect(f.run()).rejects.toThrow()
    expect(f.writes).toEqual([])
  })

  it('fails instead of reporting success for an already-published release', async () => {
    const f = fixture({ listed: [{ ...draft, draft: false }] })
    await expect(f.run()).rejects.toThrow('already published')
    expect(f.writes).toEqual([])
  })

  it.each([
    ['an untagged draft', { writeResult: { ...draft, tag_name: 'untagged-0123abcd' } }],
    [
      'a bare-version release first',
      { visible: [{ ...draft, id: 7, tag_name: '1.4.259' }, draft] }
    ],
    ['a different draft first', { visible: [{ ...draft, id: 999 }] }],
    ['a published match', { visible: [{ ...draft, draft: false }] }],
    ['no visible match', { visible: [] }]
  ])('refuses a draft the uploader would not select: %s', async (_name, options) => {
    await expect(fixture(options).run()).rejects.toThrow(/uploader|exact-tag draft/i)
  })

  it.each([{ moved: true }, { deleted: true }])(
    'refuses a tag changed after drafting: %j',
    async (options) => {
      await expect(fixture(options).run()).rejects.toThrow()
    }
  )

  it('heals existing-draft metadata and preserves the draft identity', async () => {
    const f = fixture({ existing: true })
    await f.run()
    expect(f.writes).toEqual([
      {
        method: 'PATCH',
        route: '/releases/259',
        body: { body: 'new notes', target_commitish: 'main' }
      }
    ])
  })

  it.each([
    { beforePatch: { ...draft, draft: false } },
    { writeResult: { ...draft, draft: false, body: 'original notes' } },
    {
      writeResult: { ...draft, draft: false },
      afterPatch: { ...draft, draft: false, body: 'newer edit' }
    }
  ])('fails when the existing draft is published mid-preparation: %j', async (options) => {
    await expect(fixture({ existing: true, ...options }).run()).rejects.toThrow('published')
  })
})

const workflow = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))

describe('release-cut draft wiring', () => {
  it('passes the approved source and only the job token to the helper', () => {
    const job = workflow.jobs['create-release']
    const step = job.steps.find((s) => s.id === 'draft')
    expect(step.env).toMatchObject({
      SOURCE_SHA: '${{ needs.cut.outputs.source_sha }}',
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}'
    })
    expect(job.outputs.tag_object).toBe('${{ steps.draft.outputs.tag_object }}')
  })

  it('isolates both real-process skill release suites', () => {
    for (const name of ['skill-sharing-release-gate', 'skill-sharing-linux-floor-release-gate']) {
      const step = workflow.jobs[name].steps.find((s) => s.name?.startsWith('Run skill package'))
      expect(step.env.ORCA_VITEST_ISOLATE_EVERY_FILE).toBe('1')
    }
  })

  const steps = workflow.jobs['publish-release'].steps
  const guardIndex = steps.findIndex(
    (s) => s.name === 'Verify release tag still matches the drafted source'
  )
  it('re-checks the tag immediately before undrafting', () => {
    expect(steps[guardIndex + 1].name).toBe('Publish release')
    expect(workflow.jobs['publish-release'].needs).toContain('create-release')
  })

  it.skipIf(process.platform === 'win32').each([
    ['lightweight tag unchanged', { type: 'commit', sha: checkout }, checkout, 0],
    ['annotated tag unchanged', { type: 'tag', sha: tagObject }, tagObject, 0],
    ['tag moved', { type: 'commit', sha: 'e'.repeat(40) }, checkout, 1],
    ['annotated tag recreated', { type: 'tag', sha: 'f'.repeat(40) }, tagObject, 1],
    ['tag deleted', null, checkout, 1],
    ['captured object missing', { type: 'commit', sha: checkout }, '', 1]
  ])('pre-publish guard: %s', (_name, object, captured, code) => {
    const root = mkdtempSync(join(tmpdir(), 'release-tag-guard-'))
    try {
      const gh = join(root, 'gh')
      const ref = JSON.stringify({ ref: `refs/tags/${tag}`, object })
      const annotated = JSON.stringify({
        sha: tagObject,
        object: { type: 'commit', sha: checkout }
      })
      writeFileSync(
        gh,
        `#!/bin/bash\ncase "$2" in\n*/git/ref/tags/*) ${object ? `echo '${ref}'` : 'exit 1'};;\n*/git/tags/${tagObject}) echo '${annotated}';;\n*) exit 1;;\nesac\n`
      )
      chmodSync(gh, 0o755)
      const result = runProcessSync({
        program: 'bash',
        args: ['-c', steps[guardIndex].run],
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          GITHUB_REPOSITORY: 'test/repo',
          TAG: tag,
          TAG_OBJECT: captured,
          RELEASE_SHA: checkout
        }
      })
      expect(result.code, result.stderr + result.stdout).toBe(code)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
