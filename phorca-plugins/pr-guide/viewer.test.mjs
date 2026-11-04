import assert from 'node:assert/strict'
import { it } from 'node:test'
import { prFingerprint } from './main.mjs'
import { parsePatch, renderViewer, startViewer } from './viewer.mjs'

const source = { title: 'PR', body: 'Body', headRefOid: 'a'.repeat(40), baseRefOid: 'c'.repeat(40) }
const snapshot = {
  url: 'https://github.com/a/b/pull/2',
  headSha: source.headRefOid,
  sourceFingerprint: prFingerprint(source),
  generatedAt: '2026-11-03T00:00:00.000Z',
  patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n old\n-no\n+yes\n',
  guide: {
    title: '<script> Guide', intent: 'Explain the PR',
    sections: [{ title: 'Core', overview: 'Changes A', diffs: [{ file: 'src/a.ts', summary: 'New value' }] }],
    unplacedFiles: []
  }
}

it('rejects an invalid saved guide before opening a local server', async () => {
  await assert.rejects(startViewer({ ...snapshot, guide: { ...snapshot.guide, sections: [] } }), /Invalid PR guide snapshot/)
})

it('embeds the exact PR diff in the local guide without rendering untrusted HTML', () => {
  const lines = parsePatch(snapshot.patch)[0].lines
  assert.deepEqual(lines.filter((line) => line.kind === 'add').map(({ line, side }) => ({ line, side })), [{ line: 2, side: 'RIGHT' }])
  assert.deepEqual(lines.filter((line) => line.kind === 'remove').map(({ line, side }) => ({ line, side })), [{ line: 2, side: 'LEFT' }])
  const html = renderViewer(snapshot, '/guide/test')
  assert.match(html, /Changes A/)
  assert.match(html, /guide-ui\.js/)
  assert.match(html, /guide-ui\.css/)
  assert.ok(!html.includes('<script> Guide'))
  const embedded = JSON.parse(html.match(/<script type="application\/json" id="guide-data">([^<]+)<\/script>/)[1])
  assert.equal(embedded.guide.title, snapshot.guide.title)
  assert.equal(embedded.files[0].lines.find((line) => line.kind === 'add').text, 'yes')
  assert.equal(parsePatch('diff --git "a/a b.ts" "b/a b.ts"\n--- "a/a b.ts"\n+++ "b/a b.ts"\n@@ -1 +1 @@\n-old\n+new')[0].path, 'a b.ts')
  assert.equal(parsePatch('diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-old\n+new')[0].path, 'café.ts')
})

it('navigates thematic chapters and their files without losing comment controls', () => {
  const themed = {
    ...snapshot,
    guide: {
      ...snapshot.guide,
      sections: [
        { title: 'Selection behavior', overview: 'Focus follows a selected dimension.', diffs: [{ file: 'src/a.ts', summary: 'Updates focus.' }] },
        { title: '<Tests & wiring>', overview: 'Keeps the new behavior covered.', diffs: [{ file: 'tests/b.ts', summary: 'Adds coverage.' }] }
      ]
    }
  }
  const html = renderViewer(themed, '/guide/test')
  assert.equal(JSON.parse(html.match(/id="guide-data">([^<]+)<\/script>/)[1]).guide.sections.length, 2)
  assert.match(html, /Selection behavior/)
  assert.match(html, /guide-ui\.js/)
  assert.ok(!html.includes('<Tests & wiring>'))
  assert.match(html, /\\u003cTests & wiring>/)
})

it('posts only valid current-PR inline comments to the matching GitHub PR', async () => {
  const current = { ...source }
  const calls = []
  const viewer = await startViewer(snapshot, {
    run: async (_file, args, stdin) => {
      if (args[0] === 'pr') return JSON.stringify(current)
      calls.push({ args, payload: JSON.parse(stdin) })
      return JSON.stringify({ html_url: 'https://github.com/a/b/pull/2#discussion_r1' })
    },
    generate: async () => ({ ...snapshot, headSha: current.headRefOid, sourceFingerprint: prFingerprint(current) })
  })
  const origin = new URL(viewer.url).origin
  try {
    const page = await fetch(viewer.url)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /New value/)
    const scriptUrl = html.match(/<script type="module" src="([^"]+)"/)?.[1]
    const cssUrl = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1]
    assert.ok(scriptUrl)
    assert.ok(cssUrl)
    for (const [url, type] of [
      [scriptUrl, /javascript/], [cssUrl, /css/],
      [viewer.url + '/guide-ui.js', /javascript/]
    ]) {
      const asset = await fetch(new URL(url, viewer.url))
      assert.equal(asset.status, 200)
      assert.match(asset.headers.get('content-type'), type)
      await asset.arrayBuffer()
    }
    assert.equal((await fetch(viewer.url + '/assets/not-there.js')).status, 404)
    const endpoint = viewer.url + '/comment'
    const post = (input, requestOrigin = origin) => fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: requestOrigin },
      body: JSON.stringify({ sourceFingerprint: snapshot.sourceFingerprint, ...input })
    })
    assert.equal((await post({ kind: 'inline', path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Check this' }, 'http://evil.test')).status, 403)
    assert.equal((await post({ kind: 'inline', path: 'src/a.ts', line: 99, side: 'RIGHT', body: 'Check this' })).status, 400)
    const response = await post({ kind: 'inline', path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Check this' })
    assert.equal(response.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].args[1], 'repos/a/b/pulls/2/comments')
    assert.deepEqual(calls[0].payload, { body: 'Check this', commit_id: snapshot.headSha, path: 'src/a.ts', line: 2, side: 'RIGHT' })
    assert.equal((await post({ kind: 'section', section: 0, body: 'Explain this section' })).status, 200)
    assert.equal(calls[1].args[1], 'repos/a/b/issues/2/comments')
    assert.deepEqual(calls[1].payload, { body: '**Guide section: Core**\n\nExplain this section' })
    current.title = 'Edited PR title'
    assert.equal((await post({ kind: 'inline', path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Stale' })).status, 409)
    assert.equal((await (await fetch(viewer.url + '/head?fingerprint=' + snapshot.sourceFingerprint)).json()).changed, true)
    current.headRefOid = 'b'.repeat(40)
    assert.equal((await post({ kind: 'inline', path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Still stale' })).status, 409)
    assert.equal(calls.length, 2)
    assert.equal((await (await fetch(viewer.url + '/head')).json()).headSha, current.headRefOid)
  } finally {
    viewer.close()
  }
})

it('sends inline feedback only to a selected writable local agent session', async () => {
  const calls = []
  let writable = true
  const viewer = await startViewer({ ...snapshot, worktreeId: 'repo::path' }, {
    run: async (_file, args) => {
      assert.equal(args[0], 'pr')
      return JSON.stringify(source)
    },
    listSessions: async () => writable ? [{ handle: 'term_1', title: 'Review agent', agentIdentity: 'codex' }] : [],
    sendSession: async (terminal, prompt) => { calls.push({ terminal, prompt }); return { accepted: true } }
  })
  try {
    const listed = await (await fetch(viewer.url + '/sessions')).json()
    assert.deepEqual(listed.sessions, [{ handle: 'term_1', title: 'Review agent', agentIdentity: 'codex' }])
    const post = (terminalHandle) => fetch(viewer.url + '/comment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(viewer.url).origin },
      body: JSON.stringify({ destination: 'local', terminalHandle, kind: 'inline', path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Check this', sourceFingerprint: snapshot.sourceFingerprint })
    })
    assert.equal((await post('term_shell')).status, 400)
    assert.equal((await post('term_1')).status, 200)
    assert.equal(calls[0].terminal.handle, 'term_1')
    assert.match(calls[0].prompt, /src\/a\.ts:2 \(RIGHT\)\n\nCheck this/)
    writable = false
    assert.equal((await post('term_1')).status, 400)
    assert.equal(calls.length, 1)
  } finally {
    viewer.close()
  }
})

it('offers no local sessions without an explicit terminal access provider', async () => {
  const viewer = await startViewer(snapshot)
  try {
    assert.deepEqual((await (await fetch(viewer.url + '/sessions')).json()).sessions, [])
  } finally {
    viewer.close()
  }
})
