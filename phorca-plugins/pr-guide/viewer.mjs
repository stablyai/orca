import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { generateGuide, parsePrUrl, prFingerprint, PR_SOURCE_FIELDS, runCli, saveGuide } from './main.mjs'

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char])

function patchPath(text, prefix) {
  let path = text.slice(4)
  if (path.startsWith('"')) {
    // shortcut: Git octal path escapes need a full decoder if they appear in a PR.
    try { path = JSON.parse(path) } catch { return null }
  }
  return path.startsWith(prefix) ? path.slice(2) : null
}

export function parsePatch(patch) {
  const files = []
  let file = null, oldLine = 0, newLine = 0, inHunk = false
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      file = { path: null, oldPath: null, lines: [] }
      files.push(file)
      inHunk = false
    } else if (file && text.startsWith('--- ')) {
      file.oldPath = patchPath(text, 'a/')
    } else if (file && text.startsWith('+++ b/')) {
      file.path = patchPath(text, 'b/')
    } else if (file && text.startsWith('+++ "b/')) {
      file.path = patchPath(text, 'b/')
    } else if (file && text.startsWith('+++ /dev/null')) {
      file.path = file.oldPath
    } else if (file && /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.test(text)) {
      const match = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      oldLine = Number(match[1])
      newLine = Number(match[2])
      inHunk = true
      file.lines.push({ kind: 'hunk', text })
    } else if (file && inHunk) {
      if (text.startsWith('+')) file.lines.push({ kind: 'add', text: text.slice(1), line: newLine, newLine: newLine++, side: 'RIGHT' })
      else if (text.startsWith('-')) file.lines.push({ kind: 'remove', text: text.slice(1), line: oldLine, oldLine: oldLine++, side: 'LEFT' })
      else if (text.startsWith(' ')) {
        file.lines.push({ kind: 'context', text: text.slice(1), line: newLine, oldLine: oldLine++, newLine: newLine++, side: 'RIGHT' })
      }
    }
  }
  return files.filter((entry) => entry.path)
}

export function renderViewer(snapshot, pathname) {
  const data = JSON.stringify({
    url: snapshot.url,
    headSha: snapshot.headSha,
    sourceFingerprint: snapshot.sourceFingerprint,
    guide: snapshot.guide,
    files: parsePatch(snapshot.patch),
    root: pathname
  }).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(snapshot.guide.title)} · PR Guide</title><link rel="stylesheet" href="${pathname}/guide-ui.css"></head><body><div id="guide-root"></div><script type="application/json" id="guide-data">${data}</script><script type="module" src="${pathname}/guide-ui.js"></script></body></html>`
}
export async function startViewer(initial, { run = runCli, generate = generateGuide, onRefresh = async () => undefined } = {}) {
  parsePrUrl(initial.url)
  if (!/^[0-9a-f]{40}$/i.test(initial.headSha) || !/^[0-9a-f]{64}$/i.test(initial.sourceFingerprint) || typeof initial.patch !== 'string' ||
      typeof initial.guide?.title !== 'string' || typeof initial.guide?.intent !== 'string' ||
      !Array.isArray(initial.guide?.sections) || !initial.guide.sections.length || !Array.isArray(initial.guide?.unplacedFiles) ||
      initial.guide.sections.some((section) => typeof section?.title !== 'string' || typeof section?.overview !== 'string' || !Array.isArray(section?.diffs) || section.diffs.some((ref) => typeof ref?.file !== 'string' || typeof ref?.summary !== 'string'))) {
    throw new Error('Invalid PR guide snapshot.')
  }
  let snapshot = initial
  let refreshing = null
  const secret = randomUUID()
  const pathname = `/guide/${secret}`
  const gh = process.platform === 'win32' ? 'gh.exe' : 'gh'
  const orca = process.platform === 'win32' ? 'orca.exe' : 'orca'
  const { pathname: prPath } = new URL(initial.url)
  const [, owner, repo, , number] = prPath.split('/')
  const sessions = async () => {
    const selector = snapshot.worktreeId ? `id:${snapshot.worktreeId}` : 'active'
    if (!snapshot.worktreeId) {
      const shown = JSON.parse(await run(orca, ['worktree', 'show', '--worktree', 'active', '--json']))
      if (shown.result?.worktree?.projectId?.toLowerCase() !== `github:${owner}/${repo}`.toLowerCase()) return []
    }
    const listed = JSON.parse(await run(orca, ['terminal', 'list', '--worktree', selector, '--json']))
    if (!listed.ok || !Array.isArray(listed.result?.terminals)) throw new Error('Could not list local agent sessions.')
    return listed.result.terminals
      .filter((terminal) => terminal.agentIdentity && terminal.connected && terminal.writable && !terminal.orphaned)
      .map(({ handle, title, agentIdentity }) => ({ handle, title, agentIdentity }))
  }
  const refresh = async () => {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const current = JSON.parse(await run(gh, ['pr', 'view', snapshot.url, '--json', PR_SOURCE_FIELDS]))
      if (prFingerprint(current) === snapshot.sourceFingerprint) return false
      const updated = await generate(snapshot.url)
      snapshot = await onRefresh(updated) ?? updated
      return true
    })().finally(() => { refreshing = null })
    return refreshing
  }
  const server = createServer(async (request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    if (request.headers.host !== `127.0.0.1:${server.address().port}` || !request.url?.startsWith(pathname)) {
      response.writeHead(404).end()
      return
    }
    const send = (code, value) => response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value))
    try {
      if (request.method === 'GET' && request.url === pathname) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(renderViewer(snapshot, pathname))
      } else if (request.method === 'GET' && request.url === `${pathname}/guide-ui.js`) {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }).end(await readFile(new URL('./guide-ui.js', import.meta.url)))
      } else if (request.method === 'GET' && request.url === `${pathname}/guide-ui.css`) {
        response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' }).end(await readFile(new URL('./guide-ui.css', import.meta.url)))
      } else if (request.method === 'GET' && request.url.startsWith(`${pathname}/head`)) {
        const previous = new URL(request.url, base).searchParams.get('fingerprint')
        const refreshed = await refresh()
        send(200, { changed: previous ? previous !== snapshot.sourceFingerprint : refreshed, headSha: snapshot.headSha, sourceFingerprint: snapshot.sourceFingerprint })
      } else if (request.method === 'GET' && request.url === `${pathname}/sessions`) {
        send(200, { sessions: await sessions() })
      } else if (request.method === 'POST' && request.url === `${pathname}/comment`) {
        if (request.headers.origin !== base || request.headers['content-type'] !== 'application/json') return send(403, { error: 'Invalid request origin.' })
        let raw = ''
        for await (const chunk of request) {
          raw += chunk
          if (Buffer.byteLength(raw) > 12_000) return send(413, { error: 'Comment is too large.' })
        }
        const input = JSON.parse(raw)
        const body = typeof input.body === 'string' ? input.body.trim() : ''
        if (!body || body.length > 10_000) return send(400, { error: 'Enter a comment under 10,000 characters.' })
        if (!['github', 'local'].includes(input.destination ?? 'github')) return send(400, { error: 'Select where to send the comment.' })
        if (await refresh()) return send(409, { error: 'The PR changed. Reload the guide and try again.' })
        if (input.sourceFingerprint !== snapshot.sourceFingerprint) return send(409, { error: 'The PR changed. Reload the guide and try again.' })
        let endpoint, payload
        if (input.kind === 'inline') {
          const file = parsePatch(snapshot.patch).find((entry) => entry.path === input.path)
          const line = file?.lines.find((entry) => entry.line === input.line && entry.side === input.side)
          if (!line || line.kind === 'hunk') return send(400, { error: 'Select a line in the current PR diff.' })
          endpoint = `repos/${owner}/${repo}/pulls/${number}/comments`
          payload = { body, commit_id: snapshot.headSha, path: input.path, line: input.line, side: input.side }
        } else if (input.kind === 'section' && Number.isInteger(input.section) && snapshot.guide.sections[input.section]) {
          endpoint = `repos/${owner}/${repo}/issues/${number}/comments`
          payload = { body: `**Guide section: ${snapshot.guide.sections[input.section].title}**\n\n${body}` }
        } else if (input.kind === 'general') {
          endpoint = `repos/${owner}/${repo}/issues/${number}/comments`
          payload = { body }
        } else return send(400, { error: 'Select a PR section or diff line.' })
        if (input.destination === 'local') {
          const terminal = (await sessions()).find((item) => item.handle === input.terminalHandle)
          if (!terminal) return send(400, { error: 'Select an available local agent session.' })
          const location = input.kind === 'inline' ? `${input.path}:${input.line} (${input.side})` : input.kind === 'section' ? `Guide section: ${snapshot.guide.sections[input.section].title}` : 'Entire PR'
          const prompt = `PR Guide comment for ${snapshot.url} at ${snapshot.headSha}\n${location}\n\n${body}\n\nPlease review and address this feedback in this session.`
          const receipt = JSON.parse(await run(orca, ['terminal', 'send', '--terminal', terminal.handle, '--text', prompt, '--enter', '--json']))
          if (!receipt.ok || !receipt.result?.send?.accepted) return send(503, { error: 'The local agent session did not accept the comment.' })
          send(200, { session: terminal.title })
        } else {
          const posted = JSON.parse(await run(gh, ['api', endpoint, '-X', 'POST', '--input', '-'], JSON.stringify(payload), 100_000))
          send(200, { url: posted.html_url })
        }
      } else response.writeHead(404).end()
    } catch (error) {
      send(error.status === 404 ? 404 : 500, { error: error.message })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const poll = setInterval(() => { void refresh().catch(() => undefined) }, 60_000)
  return {
    url: `http://127.0.0.1:${server.address().port}${pathname}`,
    close: () => { clearInterval(poll); server.close(); server.closeAllConnections() }
  }
}

export async function saveSnapshot(result, markdownFile) {
  const path = markdownFile.replace(/\.md$/, '.json')
  await writeFile(path, JSON.stringify(result), { flag: 'wx' })
  return path
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const snapshot = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const viewer = await startViewer(snapshot, {
      onRefresh: async (updated) => {
        const file = await saveGuide(updated)
        await saveSnapshot(updated, file)
      }
    })
    console.log(`${viewer.url}\nKeep this process running while commenting.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
