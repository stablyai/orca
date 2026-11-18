import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { COMMAND_SPECS } from '../specs'
import { GOOGLE_FILES_HANDLERS } from './google-files'

let cwd = ''
let stdout: string[] = []
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'orca-gfiles-cli-'))
  stdout = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    stdout.push(String(line))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

/** The command as typed, parsed by the real CLI parser, run against a host that answers `answer`. */
async function run(
  argv: string[],
  answer: unknown = {
    account: 'ada@acme.dev',
    id: 'ID',
    title: 'Title',
    link: 'https://docs.google.com/x',
    done: 'Done',
    ranges: [],
    file: { id: 'F', name: 'notes', mimeType: 'text/plain' }
  }
) {
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(argv, undefined, COMMAND_SPECS)
  )
  const call = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    id: 'r',
    ok: true,
    result: answer,
    _meta: { runtimeId: 'rt' }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only use `call`.
  const client = { call } as unknown as RuntimeClient
  const context: HandlerContext = { client, cwd, flags: parsed.flags, json: false, rawArgs: argv }
  await GOOGLE_FILES_HANDLERS[parsed.commandPath.join(' ')]?.(context)
  return call.mock.calls[0]
}

describe('orca drive|docs|sheets', () => {
  it('reads --tab as a name here though it is a switch elsewhere, and --formulas as a switch', async () => {
    const [method, params] =
      (await run([
        'sheets',
        'write',
        'SHEET',
        '--tab',
        'Q4 plan',
        '--formulas',
        '--range',
        'B2',
        '--values',
        '[["=A1*2"]]'
      ])) ?? []
    expect(method).toBe('google.sheets.write')
    expect(params).toMatchObject({
      ref: 'SHEET',
      tab: 'Q4 plan',
      range: 'B2',
      formulas: true,
      values: [['=A1*2']]
    })
  })

  it('takes old and new text as positionals, with --suggest anywhere', async () => {
    const [, params] =
      (await run(['docs', 'replace', 'DOC', '--suggest', 'recieve', 'receive'])) ?? []
    expect(params).toMatchObject({
      ref: 'DOC',
      pairs: [{ old: 'recieve', new: 'receive' }],
      suggest: true
    })
    const [, cut] = (await run(['docs', 'replace', 'DOC', 'very ', ''])) ?? []
    expect(cut).toMatchObject({ pairs: [{ old: 'very ', new: '' }] })
  })

  it('reads a pairs file, and refuses values that are one row instead of rows', async () => {
    writeFileSync(join(cwd, 'fixes.json'), '[{"old":"teh","new":"the"}]')
    const [, params] = (await run(['docs', 'replace', 'DOC', '--pairs-file', 'fixes.json'])) ?? []
    expect(params).toMatchObject({ pairs: [{ old: 'teh', new: 'the' }] })
    await expect(run(['sheets', 'append', 'SHEET', '--values', '["Ada",42]'])).rejects.toThrow(
      'one row is [["Ada",42]]'
    )
  })

  it('downloads with --download <file>, as gmail and slack read do, under the file’s name', async () => {
    const download = await run(['drive', 'read', '--download', 'FILE', '--out', 'saved.docx'], {
      file: { id: 'FILE', name: 'Plan', mimeType: 'x' },
      name: 'Plan.docx',
      data: Buffer.from('PK').toString('base64')
    })
    expect(download?.[1]).toMatchObject({ ref: 'FILE' })
    expect(readFileSync(join(cwd, 'saved.docx'), 'utf8')).toBe('PK')
    await run(['drive', 'read', 'FILE', '--download'], {
      file: { id: 'FILE', name: 'Plan', mimeType: 'x' },
      name: 'Plan.docx',
      data: Buffer.from('PK').toString('base64')
    })
    expect(readFileSync(join(cwd, 'Plan.docx'), 'utf8')).toBe('PK')
    expect(stdout.join('\n')).toContain('Saved Plan.docx')
  })

  it('refuses a request too large for a paired server before sending it', async () => {
    const call = run(['docs', 'append', 'DOC', '--body', 'x'.repeat(800_000)])
    await expect(call).rejects.toThrow(
      'Orca sends up to 763 KB at once. Split it into smaller parts.'
    )
  })

  it('uploads a file read here, and shares with a comma list', async () => {
    writeFileSync(join(cwd, 'notes.md'), '# Hi')
    const [method, params] =
      (await run(['drive', 'upload', 'notes.md', '--convert', '--folder', 'Q4'])) ?? []
    expect(method).toBe('google.drive.upload')
    expect(params).toMatchObject({
      name: 'notes.md',
      data: Buffer.from('# Hi').toString('base64'),
      folder: 'Q4',
      convert: true
    })
    const [, share] =
      (await run(['drive', 'share', 'FILE', '--with', 'a@x.com, b@x.com', '--no-notify'])) ?? []
    expect(share).toMatchObject({ with: ['a@x.com', 'b@x.com'], role: 'reader', notify: false })
  })
})
