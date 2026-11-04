import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  generateGuide,
  hostLocalAccess,
  openViewerInPhorca,
  parsePrUrl,
  prFingerprint,
  PR_SOURCE_FIELDS,
  readPrUrlFromClipboard,
  renderGuide,
  resolveClaudeExecutable,
  runCli,
  saveGuide,
  validateGuide
} from './main.mjs'
import activate from './main.mjs'

describe('PR Guide', () => {
  it('runs CLI processes through the bundled process host', async () => {
    assert.equal(await runCli(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok')
    await assert.rejects(runCli(process.execPath, ['-e', 'process.exit(2)']), /failed/)
  })

  it('gates local terminal discovery and sending through host capabilities', async () => {
    const hostCalls = []
    const api = { host: { call: async (method, params) => {
      hostCalls.push({ method, params })
      return method === 'workspace.readContext'
        ? { terminals: [{ id: 'term_1' }, { id: 'term_shell' }] }
        : { accepted: true }
    } } }
    const cliCalls = []
    const access = hostLocalAccess(api, async (_file, args) => {
      cliCalls.push(args)
      if (args[0] === 'worktree') return JSON.stringify({ ok: true, result: { worktree: { id: 'repo::path', projectId: 'github:a/b' } } })
      return JSON.stringify({ ok: true, result: { terminals: [
        { handle: 'term_1', title: 'Review agent', agentIdentity: 'codex', connected: true, writable: true },
        { handle: 'term_shell', title: 'Shell', agentIdentity: null, connected: true, writable: true },
        { handle: 'term_other', title: 'Other worktree', agentIdentity: 'claude', connected: true, writable: true }
      ] } })
    })
    const sessions = await access.listSessions({ url: 'https://github.com/a/b/pull/2', worktreeId: 'repo::path' })
    assert.deepEqual(sessions, [{ handle: 'term_1', title: 'Review agent', agentIdentity: 'codex' }])
    assert.deepEqual(await access.sendSession(sessions[0], 'Review this'), { accepted: true })
    assert.deepEqual(hostCalls.map(({ method }) => method), ['workspace.readContext', 'terminal.sendText'])
    assert.deepEqual(hostCalls[1].params, { terminalId: 'term_1', text: 'Review this', enter: true })
    assert.deepEqual(await access.listSessions({ url: 'https://github.com/other/repo/pull/2' }), [])
    assert.equal(cliCalls.filter((args) => args[0] === 'terminal').length, 1)
    const denied = hostLocalAccess({ host: { call: async () => { throw new Error('Capability denied') } } }, async () => { throw new Error('CLI must not run') })
    await assert.rejects(denied.listSessions({ url: 'https://github.com/a/b/pull/2' }), /Capability denied/)
  })

  it('resolves the native Claude executable on Windows and uses PATH on macOS', async () => {
    assert.equal(await resolveClaudeExecutable('darwin'), 'claude')
    const dir = await mkdtemp(join(tmpdir(), 'pr-guide-claude-'))
    try {
      const executable = join(dir, 'native', 'claude.exe')
      await mkdir(join(dir, 'native'))
      await writeFile(executable, '')
      await writeFile(join(dir, 'claude.cmd'), `@echo off\r\n"${executable}" %*\r\n`)
      assert.equal(
        await resolveClaudeExecutable('win32', dir + delimiter + join(dir, 'missing')),
        executable
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('accepts only GitHub pull request URLs', () => {
    assert.equal(
      parsePrUrl('https://github.com/phocassoftware/fs-app/pull/2640/'),
      'https://github.com/phocassoftware/fs-app/pull/2640'
    )
    for (const value of [
      'https://evil.example/phocassoftware/fs-app/pull/2640',
      'https://github.com/phocassoftware/fs-app/issues/2640',
      'https://github.com/phocassoftware/fs-app/pull/0',
      'https://github.com/phocassoftware/fs-app/pull/2640?query=1'
    ]) {
      assert.throws(() => parsePrUrl(value))
    }
  })

  it('reads a PR URL from the platform clipboard', async () => {
    assert.equal(
      await readPrUrlFromClipboard(async (file, args) => {
        assert.equal(file, 'powershell.exe')
        assert.deepEqual(args.slice(-2), ['-Command', 'Get-Clipboard -Raw'])
        return 'https://github.com/a/b/pull/2\r\n'
      }, 'win32'),
      'https://github.com/a/b/pull/2'
    )
    await assert.rejects(
      readPrUrlFromClipboard(async () => 'not a PR URL', 'darwin'),
      /pull request URL/
    )
  })

  it('reports an invalid clipboard URL instead of failing the palette command', async () => {
    const commands = {}
    const calls = []
    activate({
      commands: { register: (id, handler) => { commands[id] = handler } },
      host: { call: async (method, params) => { calls.push({ method, params }) } },
      log: () => undefined
    }, async () => { throw new Error('Enter a GitHub pull request URL.') })
    assert.deepEqual(await commands['create-guide'](), { started: false })
    assert.deepEqual(calls, [{
      method: 'notifications.show',
      params: { title: 'PR guide could not start', body: 'Enter a GitHub pull request URL.' }
    }])
  })

  it('covers omitted files and removes duplicate chapter references', () => {
    const guide = {
      title: 'Change',
      intent: 'Explain change',
      sections: [
        {
          title: 'Core',
          overview: 'Core explanation',
          diffs: [{ file: 'a.ts', summary: 'Changed A' }]
        }
      ],
      unplacedFiles: []
    }
    assert.deepEqual(validateGuide(guide, ['a.ts', 'b.ts']).unplacedFiles, ['b.ts'])
    assert.deepEqual(validateGuide({ ...guide, unplacedFiles: ['a.ts'] }, ['a.ts']).unplacedFiles, [])
    const complete = { ...guide, unplacedFiles: ['b.ts'] }
    assert.deepEqual(validateGuide(complete, ['a.ts', 'b.ts']), complete)
    assert.throws(() => validateGuide({ ...guide, sections: [{ ...guide.sections[0], diffs: [{ file: 'outside.ts', summary: 'Unrelated' }] }] }, ['a.ts']), /no chapters/i)
  })

  it('passes the PR patch to Claude and returns a file-complete guide', async () => {
    const calls = []
    const run = async (file, args, stdin) => {
      calls.push({ file, args, stdin })
      if (args[0] === 'pr' && args[1] === 'view') {
        if (args.at(-1) === PR_SOURCE_FIELDS) {
          return JSON.stringify({ title: 'Add guide', body: 'Explains the change', headRefOid: 'abc123', headRefName: 'feature' })
        }
        return JSON.stringify({
          title: 'Add guide',
          body: 'Explains the change',
          url: 'https://github.com/a/b/pull/2',
          headRefOid: 'abc123',
          headRefName: 'feature',
          changedFiles: 1
        })
      }
      if (args[0] === 'api') return '"src/a.ts"\n'
      if (args[0] === 'pr' && args[1] === 'diff') {
        return 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1'
      }
      return JSON.stringify({
        structured_output: {
          title: 'Add guide',
          intent: 'Explains the change',
          sections: [
            {
              title: 'Core',
              overview: 'Adds the core',
              diffs: [{ file: 'src/a.ts', summary: 'Exports a' }]
            }
          ],
          unplacedFiles: []
        }
      })
    }
    const result = await generateGuide('https://github.com/a/b/pull/2', run, async () => 'claude')
    assert.equal(result.guide.sections[0].diffs[0].file, 'src/a.ts')
    assert.equal(result.headSha, 'abc123')
    assert.equal(result.headBranch, 'feature')
    assert.equal(result.sourceFingerprint, prFingerprint({ title: 'Add guide', body: 'Explains the change', headRefOid: 'abc123', headRefName: 'feature' }))
    assert.match(calls[4].stdin, /diff --git a\/src\/a.ts/)
    assert.match(calls[4].stdin, /PR Guide organizer/)
    assert.match(calls[4].stdin, /Group files by purpose/)
    assert.deepEqual(calls[4].args.slice(-2), ['--tools', ''])
  })

  it('rejects a PR changed during diff capture', async () => {
    const run = async (_file, args) => {
      if (args[1] === 'diff') {
        return 'diff --git a/a.ts b/a.ts\n+change'
      }
      if (args[0] === 'api') return '"a.ts"\n'
      return args.at(-1) === PR_SOURCE_FIELDS
        ? JSON.stringify({ title: 'Change', body: '', headRefOid: 'new' })
        : JSON.stringify({
            title: 'Change',
            body: '',
            headRefOid: 'old',
            changedFiles: 1
          })
    }
    await assert.rejects(
      generateGuide('https://github.com/a/b/pull/2', run, async () => 'claude'),
      /changed while its diff was being read/
    )
  })

  it('rejects oversized PRs before requesting a diff or Claude', async () => {
    const calls = []
    const run = async (_file, args) => {
      calls.push(args)
      return JSON.stringify({ changedFiles: 16928 })
    }
    await assert.rejects(
      generateGuide('https://github.com/phocassoftware/phorca/pull/24', run, async () => 'claude'),
      /16,?928|16928.*1–250/
    )
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].slice(0, 2), ['pr', 'view'])
  })

  it('opens a Phorca tab in the active worktree', async () => {
    const calls = []
    const run = async (_file, args) => {
      calls.push(args)
      return JSON.stringify({ ok: true })
    }
    assert.equal(await openViewerInPhorca('http://127.0.0.1:1234/guide/test', run), true)
    assert.deepEqual(calls, [['tab', 'create', '--worktree', 'active', '--url', 'http://127.0.0.1:1234/guide/test', '--json']])
    assert.equal(await openViewerInPhorca('http://127.0.0.1:1234/guide/test', async () =>
      JSON.stringify({ ok: false })
    ), false)
  })

  it('saves an escaped Markdown guide outside a worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-guide-output-'))
    const previous = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = root
    try {
      const result = {
        url: 'https://github.com/a/b/pull/2',
        headSha: 'abc123',
        generatedAt: '2026-11-03T00:00:00.000Z',
        guide: {
          title: '<script> Change',
          intent: 'Explain change',
          sections: [{ title: 'Core', overview: 'Summary', diffs: [{ file: 'src/a.ts', summary: 'Changed A' }] }],
          unplacedFiles: []
        }
      }
      const file = await saveGuide(result)
      assert.ok(file.startsWith(root))
      assert.match(await readFile(file, 'utf8'), /\\<script\\>/)
      assert.match(renderGuide(result), /src\/a\\.ts/)
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = previous
      await rm(root, { recursive: true, force: true })
    }
  })
})
