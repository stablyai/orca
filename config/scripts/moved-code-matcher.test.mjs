import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as quality from './check-changed-code-quality.mjs'

const processCalls = vi.hoisted(() => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }))
// oxlint-disable-next-line anti-slop/no-module-mocking -- Test-only external process boundary; actual main executes.
vi.mock('node:child_process', () => processCalls)
// oxlint-disable-next-line anti-slop/no-module-mocking -- Resolve only the external executable used by this fixture.
vi.mock('./oxlint-cli-invocation.mjs', () => ({
  resolveOxlintInvocation: () => ({ command: 'fixture-oxlint', prefixArgs: [] })
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('moved-code matcher and changed-line gate', () => {
  it('keeps exemption decisions across different highlights in one matcher', () => {
    const body = Array.from({ length: 20 }, (_, index) => `line${index}()`)
    const blocks = [['  a()  ', '', '\tb()'], body, ['first()', 'last()']]
    const matcher = quality.createMovedCodeMatcher(blocks)
    const observations = [
      { lines: ['a()', '  ', 'b()'], moved: true },
      { lines: ['', '  '], moved: false },
      { lines: ['brandNewCall()', 'a()'], moved: false },
      { lines: ['first()', 'brandNewCall()'], moved: false },
      { lines: [...body.slice(0, 19), 'newDep,', body[19]], moved: true },
      {
        lines: ['line0()', ...Array.from({ length: 18 }, (_, index) => `fresh${index}()`)],
        moved: false
      },
      { lines: ['b()', 'a()'], moved: false }
    ]
    for (const { lines, moved } of observations) {
      expect(matcher(lines)).toBe(moved)
    }
  })

  it('reads changed base blocks when creating the next matcher', () => {
    const blocks = [['first()']]
    const matcher = quality.createMovedCodeMatcher(blocks)
    expect(matcher([])).toBe(false)
    expect(matcher(['first()'])).toBe(true)
    blocks[0][0] = 'changed()'
    const nextMatcher = quality.createMovedCodeMatcher(blocks)
    expect(nextMatcher(['changed()'])).toBe(true)
    expect(nextMatcher(['first()'])).toBe(false)
  })

  it('reports a new added-line finding from every configured scan in main', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-moved-code-main-'))
    const file = join(root, 'fixture.mjs')
    writeFileSync(file, 'brandNewCall()\n')
    vi.stubEnv('GITHUB_EVENT_NAME', '')
    processCalls.execFileSync.mockImplementation((_command, args) => {
      if (args[0] === 'rev-list') {
        return 'head parent\n'
      }
      if (args[0] === 'merge-base') {
        return 'baseline\n'
      }
      if (args[0] === 'ls-files') {
        return ''
      }
      if (args.includes('--name-status')) {
        return 'M\0fixture.mjs\0'
      }
      if (args.includes('--name-only')) {
        return 'fixture.mjs\0'
      }
      if (args.includes('--unified=0')) {
        return '@@ -0,0 +1 @@\n+brandNewCall()\n'
      }
      throw new Error(`Unexpected Git arguments: ${args.join(' ')}`)
    })
    const baseline = ['existingCall()']
    const diagnostics = [
      {
        filename: file,
        message: 'New code finding',
        labels: [{ span: { line: 1, offset: 0, length: 14 } }]
      }
    ]
    processCalls.spawnSync.mockImplementation((command, args) => {
      if (command === 'git') {
        return { status: 0, stdout: args[0] === 'show' ? baseline.join('\n') : '' }
      }
      return { status: 1, stdout: JSON.stringify({ diagnostics }), stderr: '' }
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(quality.main(root, 'baseline')).toBe(1)
      const scans = processCalls.spawnSync.mock.calls.filter(([command]) => command !== 'git')
      expect(scans).toHaveLength(quality.OXLINT_SCANS.length)
      const annotations = error.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith('::error '))
      expect(annotations).toEqual(
        Array(quality.OXLINT_SCANS.length).fill(
          '::error file=fixture.mjs,line=1,title=oxlint::New code finding'
        )
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
