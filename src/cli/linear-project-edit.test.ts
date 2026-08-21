import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', async () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode = process.env.ORCA_PAIRING_CODE ?? null,
      environmentSelector = process.env.ORCA_ENVIRONMENT ?? null
    ) {
      this.isRemote = Boolean(remotePairingCode || environmentSelector)
    }
  }

  // Why: re-export the REAL error classes; format.ts narrows with `instanceof`
  // against ./runtime/types, so a look-alike would collapse every CLI error
  // code into the generic `runtime_error` shape.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')

  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { LINEAR_WRITE_BODY_CAP } from '../shared/linear/agent-access'
import { main } from './index'
import { RuntimeRpcFailureError } from './runtime/types'
import { okFixture, queueFixtures } from './test-fixtures'

const WRITE_TIMEOUT = { timeoutMs: 75_000 }
const EDIT = ['linear', 'project', 'edit']
const PROJECT = {
  id: 'project-1',
  name: 'Payments V2',
  slugId: 'payments-v2',
  url: 'https://linear.app/acme/project/payments-v2-8f3a'
}

function boundedString(value: string) {
  return { value, truncated: false, chars: value.length, sha256: 'a'.repeat(64) }
}

function collection<TItem extends { id: string }>(items: TItem[]) {
  return {
    items,
    returned: items.length,
    total: items.length,
    truncated: false,
    sha256: 'b'.repeat(64)
  }
}

function editResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    project: PROJECT,
    changed: ['priority'],
    previous: { priority: 3 },
    current: { priority: 2 },
    meta: { workspaceId: 'workspace-1', noop: false },
    ...overrides
  }
}

function mockStdin(isTTY: boolean, chunks: string[]): { restore: () => void } {
  const stdin = process.stdin
  const previousIsTTY = stdin.isTTY
  const previousAsyncIterator = stdin[Symbol.asyncIterator]
  Object.defineProperty(stdin, 'isTTY', { configurable: true, value: isTTY })
  ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
    return undefined
  }
  return {
    restore: () => {
      Object.defineProperty(stdin, 'isTTY', { configurable: true, value: previousIsTTY })
      if (previousAsyncIterator) {
        ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = previousAsyncIterator
      } else {
        Reflect.deleteProperty(stdin, Symbol.asyncIterator)
      }
    }
  }
}

function firstError(): string {
  return String(vi.mocked(console.error).mock.calls[0][0])
}

function firstLog(): string {
  return String(vi.mocked(console.log).mock.calls[0][0])
}

function sentRequest(): Record<string, unknown> {
  return callMock.mock.calls[0][1] as Record<string, unknown>
}

async function runEdit(args: string[]): Promise<void> {
  queueFixtures(callMock, okFixture('req_edit', editResult()))
  await main([...EDIT, 'payments-v2', ...args], '/tmp/repo')
}

describe('orca linear project edit', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.env = { ...originalEnv }
    delete process.env.ORCA_PAIRING_CODE
    delete process.env.ORCA_ENVIRONMENT
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('sends only the requested fields with references as user input strings', async () => {
    await runEdit(['--status', 'In Progress', '--lead', 'me'])

    expect(callMock).toHaveBeenCalledWith(
      'linear.agentProjectEdit',
      { input: 'payments-v2', workspaceId: undefined, status: 'In Progress', lead: 'me' },
      WRITE_TIMEOUT
    )
  })

  it('requires at least one field or clear flag and issues no RPC', async () => {
    await main([...EDIT, 'payments-v2'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('at least one field flag or --clear-* flag')
  })

  it('rejects --write-id as an unknown flag for this command', async () => {
    await main(
      [...EDIT, 'payments-v2', '--name', 'P', '--write-id', '6d1c5a7e-3ac8-4f75-b9dc-f7af49d91234'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Unknown flag --write-id for command: linear project edit')
  })

  it.each([
    ['description', '--description', 'text'],
    ['content', '--content', 'text'],
    ['lead', '--lead', 'ada'],
    ['members', '--member', 'ada'],
    ['labels', '--label', 'Launch'],
    ['start-date', '--start-date', '2026-01-01'],
    ['target-date', '--target-date', '2026-02-01']
  ])('rejects the %s value flag alongside its clear flag', async (field, flag, value) => {
    const clearFlag = `--clear-${field}`

    await main([...EDIT, 'payments-v2', flag, value, clearFlag], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain(`Use either ${flag} or ${clearFlag}, not both`)
  })

  it('rejects --content-file alongside --clear-content', async () => {
    await main([...EDIT, 'payments-v2', '--content-file', '-', '--clear-content'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Use either --content-file or --clear-content, not both')
  })

  // Why: `--flag=value` parses before the boolean lookup, so a negated clear must
  // not read as a clear — that would silently destroy the field it meant to keep.
  it('leaves the field untouched when a --clear-* flag is negated', async () => {
    await runEdit(['--clear-content=false', '--name', 'Payments V3'])

    expect(sentRequest()).toEqual({ input: 'payments-v2', name: 'Payments V3' })
  })

  // Why: `--clear-content=true` has to mean the same as bare `--clear-content`, or a
  // caller spelling the value out would silently keep the content it asked to drop.
  it('clears the field when a --clear-* flag is spelled with an explicit true', async () => {
    await runEdit(['--clear-content=true'])

    expect(sentRequest()).toEqual({ input: 'payments-v2', content: null })
  })

  it('rejects a --clear-* flag carrying a value that is not a boolean', async () => {
    await main([...EDIT, 'payments-v2', '--clear-content=maybe'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--clear-content is a boolean flag')
  })

  // Why: `--json=true` is a boolean spelling scripts already use; rejecting it would
  // break every caller that passes the flag that way.
  it('accepts a boolean global flag written as --json=true', async () => {
    await runEdit(['--json=true', '--name', 'Payments V3'])

    expect(callMock).toHaveBeenCalled()
    expect(JSON.parse(firstLog())).toMatchObject({ ok: true })
  })

  it('drops a boolean global flag written as --json=false', async () => {
    await runEdit(['--json=false', '--name', 'Payments V3'])

    expect(() => JSON.parse(firstLog())).toThrow()
  })

  it('clears description to empty text and content, lead and dates to null', async () => {
    await runEdit([
      '--clear-description',
      '--clear-content',
      '--clear-lead',
      '--clear-start-date',
      '--clear-target-date'
    ])

    expect(sentRequest()).toEqual({
      input: 'payments-v2',
      workspaceId: undefined,
      description: '',
      content: null,
      lead: null,
      startDate: null,
      targetDate: null
    })
  })

  it('clears members and labels to empty collections', async () => {
    await runEdit(['--clear-members', '--clear-labels'])

    expect(sentRequest()).toMatchObject({ members: [], labels: [] })
  })

  it('replaces the whole member, team and label collections and deduplicates them', async () => {
    await runEdit([
      '--member',
      'ada',
      '--member',
      'grace',
      '--member',
      'ada',
      '--team',
      'ENG',
      '--team',
      'ENG',
      '--label',
      'Launch',
      '--label=Q3'
    ])

    expect(sentRequest()).toMatchObject({
      members: ['ada', 'grace'],
      teams: ['ENG'],
      labels: ['Launch', 'Q3']
    })
  })

  it('rejects an empty team replacement because a project always has a team', async () => {
    await main([...EDIT, 'payments-v2', '--team'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('a project edit cannot remove every team')
  })

  it('rejects an empty member replacement and names the clear flag instead', async () => {
    await main([...EDIT, 'payments-v2', '--member'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('use --clear-members to empty it')
  })

  it('normalizes CRLF and lone CR while preserving other whitespace and Unicode forms', async () => {
    await runEdit(['--description= a\r\nb ', '--content=é x\ry'])

    expect(sentRequest()).toMatchObject({
      description: ' a\nb ',
      content: 'é x\ny'
    })
  })

  it('keeps an explicitly empty description as a meaningful value', async () => {
    await runEdit(['--description='])

    expect(sentRequest()).toMatchObject({ description: '' })
  })

  it('reads --content-file - from stdin and normalizes it before the RPC', async () => {
    const stdin = mockStdin(false, ['line one\r\n', 'line two\rline three'])
    queueFixtures(callMock, okFixture('req_edit', editResult()))

    try {
      await main([...EDIT, 'payments-v2', '--content-file', '-'], '/tmp/repo')
    } finally {
      stdin.restore()
    }

    expect(sentRequest().content).toBe('line one\nline two\nline three')
  })

  it('rejects --content-file - when stdin is a TTY', async () => {
    const stdin = mockStdin(true, [])

    try {
      await main([...EDIT, 'payments-v2', '--content-file', '-'], '/tmp/repo')
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('stdin is a TTY')
  })

  it('rejects an empty piped stdin body instead of silently wiping content', async () => {
    const stdin = mockStdin(false, [])

    try {
      await main([...EDIT, 'payments-v2', '--content-file', '-'], '/tmp/repo')
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('empty or blank')
  })

  it('rejects a whitespace-only piped stdin body instead of silently wiping content', async () => {
    const stdin = mockStdin(false, ['\n', '  \t'])

    try {
      await main([...EDIT, 'payments-v2', '--content-file', '-'], '/tmp/repo')
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('empty or blank')
  })

  // Why: over SSH, orca runs on the desktop host with ORCA_CLI_SSH_REMOTE set — a
  // --content-file path here would read the wrong machine's disk. The WSL bridge
  // sets the shared ORCA_CLI_CWD too, but must NOT trip this SSH-only guard.
  it('rejects --content-file <path> when ORCA_CLI_SSH_REMOTE signals a forwarded SSH shell', async () => {
    const previous = process.env.ORCA_CLI_SSH_REMOTE
    process.env.ORCA_CLI_SSH_REMOTE = '1'

    try {
      await main([...EDIT, 'payments-v2', '--content-file', 'overview.md'], '/tmp/repo')
    } finally {
      if (previous === undefined) {
        delete process.env.ORCA_CLI_SSH_REMOTE
      } else {
        process.env.ORCA_CLI_SSH_REMOTE = previous
      }
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('not this SSH remote')
  })

  // Why: the WSL bridge sets the same ORCA_CLI_CWD the SSH passthrough does, but its
  // UNC cwd stays host-readable, so ORCA_CLI_CWD alone must not trip the SSH guard.
  it('does not reject --content-file <path> from a WSL-forwarded shell', async () => {
    const { writeFile, rm, mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'orca-wsl-content-'))
    const file = join(dir, 'overview.md')
    await writeFile(file, 'overview from a WSL-visible path', 'utf8')
    const previous = process.env.ORCA_CLI_CWD
    process.env.ORCA_CLI_CWD = dir
    queueFixtures(callMock, okFixture('req_edit', editResult()))

    try {
      await main([...EDIT, 'payments-v2', '--content-file', file], '/tmp/repo')
    } finally {
      if (previous === undefined) {
        delete process.env.ORCA_CLI_CWD
      } else {
        process.env.ORCA_CLI_CWD = previous
      }
      await rm(dir, { recursive: true, force: true })
    }

    expect(sentRequest().content).toBe('overview from a WSL-visible path')
  })

  it('rejects a clear conflict before consuming piped stdin', async () => {
    const stdin = mockStdin(false, ['overview from stdin'])

    try {
      await main([...EDIT, 'payments-v2', '--content-file', '-', '--clear-content'], '/tmp/repo')
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('not both')
  })

  it('rejects over-cap content with linear_body_too_large and no RPC', async () => {
    await main(
      [...EDIT, 'payments-v2', `--content=${'a'.repeat(LINEAR_WRITE_BODY_CAP + 1)}`, '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = JSON.parse(firstLog()) as { error: { code: string } }
    expect(printed.error.code).toBe('linear_body_too_large')
  })

  it('counts CRLF as one character against the body cap', async () => {
    queueFixtures(callMock, okFixture('req_edit', editResult()))

    await main(
      [...EDIT, 'payments-v2', `--content=${'a\r\n'.repeat(LINEAR_WRITE_BODY_CAP / 2)}`],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(String(sentRequest().content)).toHaveLength(LINEAR_WRITE_BODY_CAP)
  })

  it('rejects an impossible calendar date before any RPC', async () => {
    await main([...EDIT, 'payments-v2', '--target-date', '2026-02-30'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--target-date must be a real calendar date')
  })

  it('rejects a non-ISO start date before any RPC', async () => {
    await main([...EDIT, 'payments-v2', '--start-date', '07/01/2026'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--start-date must use YYYY-MM-DD')
  })

  it('rejects a malformed --color before any RPC', async () => {
    await main([...EDIT, 'payments-v2', '--color', '4EA7FC'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--color must be #RRGGBB')
  })

  it('rejects a blank --name before any RPC', async () => {
    await main([...EDIT, 'payments-v2', '--name', '   '], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--name must not be blank')
  })

  // Why: Linear enforces both caps server-side as a generic Argument Validation
  // Error, and on edit it arrives only after the pre-edit snapshot has paged
  // every member, team and label connection.
  it('rejects an over-cap --description before any RPC', async () => {
    await main([...EDIT, 'payments-v2', '--description', 'd'.repeat(256)], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--description must be at most 255 characters, but is 256')
    expect(firstError()).toContain('--content')
  })

  it('accepts a --description at exactly the cap', async () => {
    await runEdit(['--description', 'd'.repeat(255)])

    expect(sentRequest().description).toHaveLength(255)
  })

  // Why: Linear counts code points, so 255 emoji fit even though String.length is 510.
  it('counts --description code points, not UTF-16 units', async () => {
    await runEdit(['--description', '\u{1F600}'.repeat(255)])

    expect([...(sentRequest().description as string)]).toHaveLength(255)
  })

  it('rejects an over-cap --name before any RPC', async () => {
    await main([...EDIT, 'payments-v2', '--name', 'n'.repeat(81)], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--name must be at most 80 characters, but is 81')
  })

  it('maps --priority none to 0 instead of dropping it as falsy', async () => {
    await runEdit(['--priority', 'none'])

    expect(sentRequest().priority).toBe(0)
  })

  it('rejects --workspace all with linear_invalid_workspace and no RPC', async () => {
    await main([...EDIT, 'payments-v2', '--name', 'P', '--workspace', 'all', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    const printed = JSON.parse(firstLog()) as { error: { code: string; message: string } }
    expect(printed.error.code).toBe('linear_invalid_workspace')
    // Why: an edit is a write, so it must use the write wording every other project
    // write uses — including the SSH shim. See ssh-remote-linear-project-cli-parity.test.ts.
    expect(printed.error.message).toBe('--workspace all is not valid for Linear writes')
  })

  it('requires a project target', async () => {
    await main([...EDIT, '--name', 'P'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Pass a Linear project UUID')
  })

  it('emits the full result envelope in --json mode', async () => {
    queueFixtures(
      callMock,
      okFixture(
        'req_edit',
        editResult({
          changed: ['name', 'members'],
          previous: { name: 'Payments', members: collection([]) },
          current: {
            name: 'Payments V2',
            members: collection([{ id: 'user-1', displayName: 'Ada', avatarUrl: null }])
          }
        })
      )
    )

    await main(
      [...EDIT, 'payments-v2', '--name', 'Payments V2', '--member', 'ada', '--json'],
      '/tmp/repo'
    )

    const printed = JSON.parse(firstLog()) as {
      ok: boolean
      result: {
        project: { id: string }
        changed: string[]
        previous: { name: string }
        current: { name: string }
        meta: { workspaceId: string; noop: boolean }
      }
    }
    expect(printed.ok).toBe(true)
    expect(printed.result.project.id).toBe('project-1')
    expect(printed.result.changed).toEqual(['name', 'members'])
    expect(printed.result.previous.name).toBe('Payments')
    expect(printed.result.current.name).toBe('Payments V2')
    expect(printed.result.meta).toEqual({ workspaceId: 'workspace-1', noop: false })
  })

  it('renders previous -> current for each requested field in human output', async () => {
    queueFixtures(
      callMock,
      okFixture(
        'req_edit',
        editResult({
          changed: ['description', 'members'],
          previous: { description: boundedString('old'), members: collection([]), priority: 2 },
          current: {
            description: boundedString('newer'),
            members: collection([{ id: 'user-1', displayName: 'Ada', avatarUrl: null }]),
            priority: 2
          }
        })
      )
    )

    await main(
      [...EDIT, 'payments-v2', '--description', 'newer', '--member', 'ada', '--priority', 'high'],
      '/tmp/repo'
    )

    const output = firstLog()
    expect(output).toContain('Edited Linear project Payments V2 (payments-v2)')
    expect(output).toContain('Changed: description, members')
    expect(output).toContain(`description: 3 chars sha256 ${'a'.repeat(64)} -> 5 chars sha256`)
    expect(output).toContain(`members (replaced): 0 sha256 ${'b'.repeat(64)} -> 1 sha256`)
    expect(output).toContain('priority: high -> high (unchanged)')
  })

  it('clearly marks a no-op edit so a retry is never read as a write', async () => {
    queueFixtures(
      callMock,
      okFixture(
        'req_edit',
        editResult({
          changed: [],
          previous: { priority: 2 },
          current: { priority: 2 },
          meta: { workspaceId: 'workspace-1', noop: true }
        })
      )
    )

    await main([...EDIT, 'payments-v2', '--priority', 'high'], '/tmp/repo')

    const output = firstLog()
    expect(output).toContain('No changes to Linear project Payments V2 (payments-v2)')
    expect(output).toContain(
      'No-op: every requested field already held the requested value; no write was sent.'
    )
    expect(output).toContain('Changed: none')
    expect(output).not.toContain('Edited Linear project')
  })

  it('rewrites method_not_found into an upgrade instruction', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_edit',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method linear.agentProjectEdit' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )

    await main([...EDIT, 'payments-v2', '--name', 'P'], '/tmp/repo')

    const stderr = firstError()
    expect(stderr).toContain('This Orca host does not support `orca linear project edit`.')
    expect(stderr).not.toContain('method_not_found')
    expect(process.exitCode).toBe(1)
  })

  it('documents replace-vs-clear semantics and the missing write id in its own help', async () => {
    await main([...EDIT, '--help'], '/tmp/repo')

    const output = firstLog()
    expect(output).toContain('orca linear project edit')
    expect(output).toContain('Replace ALL members')
    expect(output).toContain('--clear-members')
    expect(output).toContain(
      'Repeated --member, --team, and --label REPLACE the whole collection; they never append.'
    )
    expect(output).toContain('There is no --write-id')
    expect(output).toContain('verified by reading the fields back')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('lists every Linear project command in the group help', async () => {
    await main(['linear', 'project', '--help'], '/tmp/repo')

    const output = firstLog()
    const listed = output
      .split('\n')
      .filter((line) => line.startsWith('  ') && !line.startsWith('   '))
      .map((line) => line.slice(2).split('  ')[0])
    expect(listed).toEqual([
      'show',
      'statuses',
      'labels',
      'create',
      'edit',
      'update add',
      'list' // Why: `linear project list` predates this group and still belongs to it.
    ])
    expect(output).toContain('Edit Linear project fields')
    expect(callMock).not.toHaveBeenCalled()
  })
})
