import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { uploadSshRelayRuntimeDraftAssets } from './ssh-relay-runtime-draft-upload.mjs'

const REPO = 'stablyai/orca'
const RELEASE_ID = 42
const TAG = 'v1.5.0-rc.1'
const SOURCE_COMMIT = 'a'.repeat(40)
const TOKEN = 'test-token'
const NAME = 'orca-ssh-relay-runtime-v1-linux-x64-glibc-a.tar.br'
const BYTES = Buffer.from('immutable relay runtime bytes')
const SECOND_NAME = 'orca-ssh-relay-runtime-manifest.json'
const SECOND_BYTES = Buffer.from('immutable signed manifest bytes')

let root

function digest(bytes = BYTES) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function localAsset(overrides = {}) {
  return {
    name: NAME,
    path: join(root, NAME),
    sha256: digest(),
    size: BYTES.length,
    ...overrides
  }
}

function draft(assets = [], overrides = {}) {
  return {
    id: RELEASE_ID,
    tag_name: TAG,
    target_commitish: 'main',
    draft: true,
    assets,
    ...overrides
  }
}

function tagReference(sha = SOURCE_COMMIT, type = 'commit') {
  return { object: { sha, type } }
}

function uploadedAsset(overrides = {}) {
  return { id: 101, name: NAME, state: 'uploaded', size: BYTES.length, ...overrides }
}

function json(body, status = 200) {
  return Response.json(body, { status })
}

async function requestBytes(options) {
  const chunks = []
  for await (const chunk of options.body) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function input(fetchImpl, overrides = {}) {
  return {
    repo: REPO,
    releaseId: RELEASE_ID,
    tag: TAG,
    sourceCommit: SOURCE_COMMIT,
    token: TOKEN,
    assets: [localAsset()],
    fetchImpl,
    delayImpl: vi.fn(async () => {}),
    ...overrides
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-relay-draft-upload-'))
  await writeFile(join(root, NAME), BYTES)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('SSH relay runtime draft upload', () => {
  it('uploads only locally verified immutable bytes to the exact draft', async () => {
    const bodies = []
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') {
        bodies.push(await requestBytes(options))
        return json(uploadedAsset(), 201)
      }
      if (url.includes('/git/ref/tags/')) {
        return json(tagReference())
      }
      return json(draft())
    })

    await expect(uploadSshRelayRuntimeDraftAssets(input(fetchImpl))).resolves.toEqual({
      releaseId: RELEASE_ID,
      tag: TAG,
      sourceCommit: SOURCE_COMMIT,
      reusedAssets: [],
      uploadedAssets: [{ name: NAME, sha256: digest(), size: BYTES.length }]
    })
    expect(bodies).toEqual([BYTES])
    const [url, options] = fetchImpl.mock.calls.find(([, value]) => value.method === 'POST')
    expect(url).toBe(
      `https://uploads.github.com/repos/${REPO}/releases/${RELEASE_ID}/assets?name=${NAME}`
    )
    expect(options.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Length': String(BYTES.length),
      'Content-Type': 'application/octet-stream'
    })
  })

  it('settles an unconsumed upload stream before returning', async () => {
    let uploadBody
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') {
        uploadBody = options.body
        return json(uploadedAsset(), 201)
      }
      return url.includes('/git/ref/tags/') ? json(tagReference()) : json(draft())
    })

    await expect(uploadSshRelayRuntimeDraftAssets(input(fetchImpl))).resolves.toMatchObject({
      uploadedAssets: [{ name: NAME, sha256: digest(), size: BYTES.length }]
    })
    expect(uploadBody).toBeDefined()
    expect(uploadBody.closed).toBe(true)
  })

  it('reuses only same-draft assets whose downloaded bytes match', async () => {
    const location = 'https://release-assets.githubusercontent.com/example/runtime?sig=signed'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(draft([uploadedAsset()])))
      .mockResolvedValueOnce(json(tagReference()))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
      .mockResolvedValueOnce(new Response(BYTES))

    await expect(uploadSshRelayRuntimeDraftAssets(input(fetchImpl))).resolves.toMatchObject({
      reusedAssets: [{ name: NAME, sha256: digest(), size: BYTES.length }],
      uploadedAssets: []
    })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(fetchImpl.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false)
    expect(fetchImpl.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(fetchImpl.mock.calls[3][0]).toBe(location)
    expect(fetchImpl.mock.calls[3][1].headers).not.toHaveProperty('Authorization')
  })

  it('peels annotated tags to the exact source commit', async () => {
    const tagSha = 'b'.repeat(40)
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(draft()))
      .mockResolvedValueOnce(json(tagReference(tagSha, 'tag')))
      .mockResolvedValueOnce(json(tagReference()))
      .mockResolvedValueOnce(json(uploadedAsset(), 201))

    await expect(uploadSshRelayRuntimeDraftAssets(input(fetchImpl))).resolves.toMatchObject({
      uploadedAssets: [{ name: NAME, sha256: digest(), size: BYTES.length }]
    })
    expect(fetchImpl.mock.calls[2][0]).toBe(
      `https://api.github.com/repos/${REPO}/git/tags/${tagSha}`
    )
  })

  it('fails closed on unsafe draft state or existing managed bytes', async () => {
    for (const release of [
      draft([], { draft: false }),
      draft([], { tag_name: 'v1.5.0-rc.2' }),
      draft([uploadedAsset({ name: 'orca-ssh-relay-runtime-unexpected.zip' })])
    ]) {
      await expect(
        uploadSshRelayRuntimeDraftAssets(input(vi.fn().mockResolvedValueOnce(json(release))))
      ).rejects.toThrow(/draft|tag|source commit|unexpected managed asset/i)
    }

    const wrongSourceFetch = vi
      .fn()
      .mockResolvedValueOnce(json(draft()))
      .mockResolvedValueOnce(json(tagReference('b'.repeat(40))))
    await expect(uploadSshRelayRuntimeDraftAssets(input(wrongSourceFetch))).rejects.toThrow(
      /source commit.*tag/i
    )

    const changedFetch = vi
      .fn()
      .mockResolvedValueOnce(json(draft([uploadedAsset()])))
      .mockResolvedValueOnce(json(tagReference()))
      .mockResolvedValueOnce(new Response(Buffer.from('changed bytes')))
    await expect(uploadSshRelayRuntimeDraftAssets(input(changedFetch))).rejects.toThrow(
      /size|sha-?256/i
    )
  })

  it('reconciles an uncertain retry before sending the same bytes again', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(draft()))
      .mockResolvedValueOnce(json(tagReference()))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(json(draft([uploadedAsset()])))
      .mockResolvedValueOnce(json(tagReference()))
      .mockResolvedValueOnce(new Response(BYTES))

    await expect(uploadSshRelayRuntimeDraftAssets(input(fetchImpl))).resolves.toMatchObject({
      reusedAssets: [{ name: NAME, sha256: digest(), size: BYTES.length }],
      uploadedAssets: []
    })
    expect(fetchImpl.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
  })

  it('leaves a partial draft recoverable without replacing uploaded bytes', async () => {
    await writeFile(join(root, SECOND_NAME), SECOND_BYTES)
    const assets = [
      localAsset(),
      localAsset({
        name: SECOND_NAME,
        path: join(root, SECOND_NAME),
        sha256: digest(SECOND_BYTES),
        size: SECOND_BYTES.length
      })
    ]
    const firstAttempt = vi
      .fn()
      .mockResolvedValueOnce(json(draft()))
      .mockResolvedValueOnce(json(tagReference()))
      .mockResolvedValueOnce(json(uploadedAsset(), 201))
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
    await expect(uploadSshRelayRuntimeDraftAssets(input(firstAttempt, { assets }))).rejects.toThrow(
      /403/i
    )

    const recovery = vi
      .fn()
      .mockResolvedValueOnce(json(draft([uploadedAsset()])))
      .mockResolvedValueOnce(json(tagReference()))
      .mockResolvedValueOnce(new Response(BYTES))
      .mockResolvedValueOnce(
        json(uploadedAsset({ id: 102, name: SECOND_NAME, size: SECOND_BYTES.length }), 201)
      )
    await expect(
      uploadSshRelayRuntimeDraftAssets(input(recovery, { assets }))
    ).resolves.toMatchObject({
      reusedAssets: [{ name: NAME, sha256: digest(), size: BYTES.length }],
      uploadedAssets: [
        { name: SECOND_NAME, sha256: digest(SECOND_BYTES), size: SECOND_BYTES.length }
      ]
    })
  })

  it('bounds retries and detects local mutation before another upload attempt', async () => {
    const retryingFetch = vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') {
        return new Response('unavailable', { status: 503 })
      }
      return url.includes('/git/ref/tags/') ? json(tagReference()) : json(draft())
    })
    const delayImpl = vi.fn(async () => {})
    await expect(
      uploadSshRelayRuntimeDraftAssets(input(retryingFetch, { delayImpl }))
    ).rejects.toThrow(/retry exhaustion/i)
    expect(
      retryingFetch.mock.calls.filter(([, options]) => options.method === 'POST')
    ).toHaveLength(3)
    expect(delayImpl).toHaveBeenCalledTimes(2)

    const mutationFetch = vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') {
        return new Response('unavailable', { status: 503 })
      }
      return url.includes('/git/ref/tags/') ? json(tagReference()) : json(draft())
    })
    const mutateBeforeRetry = vi.fn(async () => {
      await writeFile(join(root, NAME), Buffer.from('mutated relay runtime bytes'))
    })
    await expect(
      uploadSshRelayRuntimeDraftAssets(input(mutationFetch, { delayImpl: mutateBeforeRetry }))
    ).rejects.toThrow(/local.*size|local.*sha-?256/i)
    expect(
      mutationFetch.mock.calls.filter(([, options]) => options.method === 'POST')
    ).toHaveLength(1)
  })

  it('does not retry authorization failures and honors cancellation before requests', async () => {
    const deniedFetch = vi
      .fn()
      .mockResolvedValueOnce(json(draft()))
      .mockResolvedValueOnce(json(tagReference()))
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
    await expect(uploadSshRelayRuntimeDraftAssets(input(deniedFetch))).rejects.toThrow(/403/i)
    expect(deniedFetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(
      1
    )

    const controller = new AbortController()
    controller.abort(new Error('cancel draft upload'))
    const cancelledFetch = vi.fn()
    await expect(
      uploadSshRelayRuntimeDraftAssets(input(cancelledFetch, { signal: controller.signal }))
    ).rejects.toThrow(/cancel draft upload/i)
    expect(cancelledFetch).not.toHaveBeenCalled()
  })
})
