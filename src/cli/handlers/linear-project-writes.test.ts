import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', async () => {
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
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')

  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { LINEAR_WRITE_BODY_CAP } from '../../shared/linear/agent-access'
import { main } from '../index'
import { RuntimeRpcFailureError } from '../runtime/types'
import { okFixture, queueFixtures } from '../test-fixtures'

const WRITE_ID = '123e4567-e89b-12d3-a456-426614174000'
const WRITE_TIMEOUT = { timeoutMs: 75_000 }

function updateAddResult(metaOverrides: Record<string, unknown> = {}): unknown {
  return {
    projectUpdate: {
      id: 'update-1',
      url: 'https://linear.app/acme/project/launch-q3-1a2b3c#update-1',
      health: 'onTrack',
      createdAt: '2026-06-01T00:00:00.000Z'
    },
    project: {
      id: 'project-1',
      name: 'Launch Q3',
      slugId: 'launch-q3',
      url: 'https://linear.app/acme/project/launch-q3-1a2b3c'
    },
    meta: {
      workspaceId: 'workspace-1',
      bodyChars: 11,
      writeId: WRITE_ID,
      deduplicated: false,
      ...metaOverrides
    }
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

describe('orca linear project update add', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.env = { ...originalEnv }
    delete process.env.ORCA_WORKTREE_ID
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PAIRING_CODE
    delete process.env.ORCA_ENVIRONMENT
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('posts a positional target with an explicit isDiffHidden false', async () => {
    queueFixtures(callMock, okFixture('req_update', updateAddResult()))

    await main(
      ['linear', 'project', 'update', 'add', 'launch-q3', '--body', 'Rails merged', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'linear.agentProjectUpdateAdd',
      {
        input: 'launch-q3',
        workspaceId: undefined,
        body: 'Rails merged',
        isDiffHidden: false,
        writeId: undefined
      },
      WRITE_TIMEOUT
    )
  })

  // Why: `--flag=value` parses before the boolean lookup, so an uncoerced `--hide-diff=true`
  // read as off and posted the update with the diff the caller asked to hide.
  it.each([
    ['--hide-diff', true],
    ['--hide-diff=true', true],
    ['--hide-diff=false', false]
  ])('reads %s as isDiffHidden %s', async (token, expected) => {
    queueFixtures(callMock, okFixture('req_update', updateAddResult()))

    await main(
      [
        'linear',
        'project',
        'update',
        'add',
        'launch-q3',
        '--body',
        'Rails merged',
        token,
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'linear.agentProjectUpdateAdd',
      {
        input: 'launch-q3',
        workspaceId: undefined,
        body: 'Rails merged',
        isDiffHidden: expected,
        writeId: undefined
      },
      WRITE_TIMEOUT
    )
  })

  it('sends --id, --workspace, normalized --health, --hide-diff and --write-id', async () => {
    queueFixtures(callMock, okFixture('req_update', updateAddResult()))

    await main(
      [
        'linear',
        'project',
        'update',
        'add',
        '--id',
        'launch-q3',
        '--workspace',
        'workspace-1',
        '--body',
        'Rails merged',
        '--health',
        'on-track',
        '--hide-diff',
        '--write-id',
        WRITE_ID,
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'linear.agentProjectUpdateAdd',
      {
        input: 'launch-q3',
        workspaceId: 'workspace-1',
        body: 'Rails merged',
        health: 'onTrack',
        isDiffHidden: true,
        writeId: WRITE_ID
      },
      WRITE_TIMEOUT
    )
  })

  it('maps every accepted --health value to its API spelling', async () => {
    for (const [cli, api] of [
      ['on-track', 'onTrack'],
      ['at-risk', 'atRisk'],
      ['off-track', 'offTrack']
    ]) {
      callMock.mockReset()
      queueFixtures(callMock, okFixture('req_update', updateAddResult()))

      await main(
        ['linear', 'project', 'update', 'add', 'launch-q3', '--body', 'x', '--health', cli],
        '/tmp/repo'
      )

      expect(callMock.mock.calls[0][1]).toMatchObject({ health: api })
    }
  })

  it('rejects the camelCase health spellings with the valid values', async () => {
    await main(
      ['linear', 'project', 'update', 'add', 'launch-q3', '--body', 'x', '--health', 'onTrack'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--health must be one of on-track, at-risk, off-track')
    expect(process.exitCode).toBe(1)
  })

  it('rejects an unknown --health value before any RPC', async () => {
    await main(
      ['linear', 'project', 'update', 'add', 'launch-q3', '--body', 'x', '--health', 'bogus'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--health must be one of on-track, at-risk, off-track')
  })

  it('requires exactly one of --body and --body-file', async () => {
    await main(
      [
        'linear',
        'project',
        'update',
        'add',
        'launch-q3',
        '--body',
        'one',
        '--body-file',
        'body.md'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Use either --body or --body-file, not both')
  })

  it('requires a body source', async () => {
    await main(['linear', 'project', 'update', 'add', 'launch-q3'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Missing --body or --body-file')
  })

  it('rejects an empty body locally without issuing an RPC', async () => {
    await main(['linear', 'project', 'update', 'add', 'launch-q3', '--body='], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Linear project update body must not be empty')
    expect(process.exitCode).toBe(1)
  })

  it('normalizes a line-ending-only body to LF instead of treating it as empty', async () => {
    queueFixtures(callMock, okFixture('req_update', updateAddResult()))

    await main(['linear', 'project', 'update', 'add', 'launch-q3', '--body=\r\n'], '/tmp/repo')

    expect(callMock.mock.calls[0][1]).toMatchObject({ body: '\n' })
  })

  it('rejects an over-cap body locally without issuing an RPC', async () => {
    await main(
      [
        'linear',
        'project',
        'update',
        'add',
        'launch-q3',
        '--body',
        'a'.repeat(LINEAR_WRITE_BODY_CAP + 1)
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain(`Linear body must be at most ${LINEAR_WRITE_BODY_CAP}`)
  })

  it('sends a CRLF body that sits exactly on the cap after normalization', async () => {
    queueFixtures(callMock, okFixture('req_update', updateAddResult()))
    const body = `${'a'.repeat(LINEAR_WRITE_BODY_CAP - 2)}\r\n`

    await main(['linear', 'project', 'update', 'add', 'launch-q3', `--body=${body}`], '/tmp/repo')

    expect(callMock.mock.calls[0][1]).toMatchObject({
      body: `${'a'.repeat(LINEAR_WRITE_BODY_CAP - 2)}\n`
    })
  })

  it('reads --body-file - from stdin and normalizes CRLF and lone CR to LF', async () => {
    const stdin = mockStdin(false, ['line one\r\n', 'line two\rline three'])
    queueFixtures(callMock, okFixture('req_update', updateAddResult()))

    try {
      await main(
        ['linear', 'project', 'update', 'add', 'launch-q3', '--body-file', '-', '--json'],
        '/tmp/repo'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock.mock.calls[0][1]).toMatchObject({
      body: 'line one\nline two\nline three'
    })
  })

  it('rejects --body-file - when stdin is a TTY', async () => {
    const stdin = mockStdin(true, [])

    try {
      await main(
        ['linear', 'project', 'update', 'add', 'launch-q3', '--body-file', '-'],
        '/tmp/repo'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('stdin body requested but stdin is a TTY')
  })

  it('rejects an empty stdin body before any RPC', async () => {
    const stdin = mockStdin(false, [])

    try {
      await main(
        ['linear', 'project', 'update', 'add', 'launch-q3', '--body-file', '-'],
        '/tmp/repo'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('empty or blank')
  })

  it('preserves other whitespace and Unicode normalization forms verbatim', async () => {
    queueFixtures(callMock, okFixture('req_update', updateAddResult()))
    // Why: decomposed e + tab + NBSP + trailing space must survive untouched.
    const body = ' é\tcafé end '

    await main(['linear', 'project', 'update', 'add', 'launch-q3', `--body=${body}`], '/tmp/repo')

    expect(callMock.mock.calls[0][1]).toMatchObject({ body })
  })

  it('rejects --workspace all with linear_invalid_workspace and no RPC', async () => {
    await main(
      [
        'linear',
        'project',
        'update',
        'add',
        'launch-q3',
        '--body',
        'x',
        '--workspace',
        'all',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = JSON.parse(firstLog()) as { error: { code: string; message: string } }
    expect(printed.error.code).toBe('linear_invalid_workspace')
    // Why: posting an update is a write, so it shares the write wording with create, edit
    // and the SSH shim. See ssh-remote-linear-project-cli-parity.test.ts.
    expect(printed.error.message).toBe('--workspace all is not valid for Linear writes')
  })

  it('rejects a malformed --write-id with linear_invalid_write_id and no RPC', async () => {
    await main(
      [
        'linear',
        'project',
        'update',
        'add',
        'launch-q3',
        '--body',
        'x',
        '--write-id',
        'not-a-uuid',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = JSON.parse(firstLog()) as { error: { code: string; message: string } }
    expect(printed.error.code).toBe('linear_invalid_write_id')
    expect(printed.error.message).toContain('--write-id must be a UUID')
  })

  it('rejects a malformed --write-id before consuming stdin', async () => {
    const stdin = mockStdin(false, ['body from stdin'])

    try {
      await main(
        [
          'linear',
          'project',
          'update',
          'add',
          'launch-q3',
          '--body-file',
          '-',
          '--write-id',
          'not-a-uuid'
        ],
        '/tmp/repo'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--write-id must be a UUID')
  })

  it('rejects a project passed both positionally and as --id', async () => {
    await main(
      ['linear', 'project', 'update', 'add', 'launch-q3', '--id', 'other', '--body', 'x'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Pass --id either positionally or as a flag, not both.')
  })

  it('requires a project target', async () => {
    await main(['linear', 'project', 'update', 'add', '--body', 'x'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Pass a Linear project UUID, slugId, URL, or exact name')
  })

  it('emits the full result envelope in --json mode', async () => {
    queueFixtures(callMock, okFixture('req_update', updateAddResult()))

    await main(
      ['linear', 'project', 'update', 'add', 'launch-q3', '--body', 'Rails merged', '--json'],
      '/tmp/repo'
    )

    const printed = JSON.parse(firstLog()) as {
      ok: boolean
      result: {
        projectUpdate: { id: string; health: string; url: string; createdAt: string }
        project: { slugId: string }
        meta: { writeId: string; deduplicated: boolean; bodyChars: number; workspaceId: string }
      }
    }
    expect(printed.ok).toBe(true)
    expect(printed.result.projectUpdate).toEqual({
      id: 'update-1',
      url: 'https://linear.app/acme/project/launch-q3-1a2b3c#update-1',
      health: 'onTrack',
      createdAt: '2026-06-01T00:00:00.000Z'
    })
    expect(printed.result.project.slugId).toBe('launch-q3')
    expect(printed.result.meta).toEqual({
      workspaceId: 'workspace-1',
      bodyChars: 11,
      writeId: WRITE_ID,
      deduplicated: false
    })
  })

  it('renders a human summary that names the project, health and write id', async () => {
    queueFixtures(callMock, okFixture('req_update', updateAddResult()))

    await main(
      ['linear', 'project', 'update', 'add', 'launch-q3', '--body', 'Rails merged'],
      '/tmp/repo'
    )

    const output = firstLog()
    expect(output).toContain('Posted Linear project update on Launch Q3 (launch-q3)')
    expect(output).toContain('Update: update-1 on-track 2026-06-01T00:00:00.000Z')
    expect(output).toContain(`Write id: ${WRITE_ID}`)
    expect(output).not.toContain('Deduplicated')
  })

  it('clearly marks a deduplicated write in human output', async () => {
    queueFixtures(callMock, okFixture('req_update', updateAddResult({ deduplicated: true })))

    await main(
      [
        'linear',
        'project',
        'update',
        'add',
        'launch-q3',
        '--body',
        'Rails merged',
        '--write-id',
        WRITE_ID
      ],
      '/tmp/repo'
    )

    const output = firstLog()
    expect(output).toContain('Deduplicated Linear project update on Launch Q3 (launch-q3)')
    expect(output).toContain(
      'Deduplicated: the pinned --write-id already posted this update; nothing new was created.'
    )
    expect(output).not.toContain('Posted Linear project update')
  })

  it('rewrites method_not_found into an upgrade instruction in human mode', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_update',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method linear.agentProjectUpdateAdd'
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    )

    await main(['linear', 'project', 'update', 'add', 'launch-q3', '--body', 'x'], '/tmp/repo')

    const stderr = firstError()
    expect(stderr).toContain('This Orca host does not support `orca linear project update add`.')
    expect(stderr).toContain('Update the remote Orca host and retry.')
    expect(stderr).not.toContain('method_not_found')
    expect(process.exitCode).toBe(1)
  })

  it('never leaks the raw method_not_found code in --json mode', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_update',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method linear.agentProjectUpdateAdd'
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    )

    await main(
      ['linear', 'project', 'update', 'add', 'launch-q3', '--body', 'x', '--json'],
      '/tmp/repo'
    )

    const printed = firstLog()
    expect(printed).not.toContain('method_not_found')
    const parsed = JSON.parse(printed) as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('unsupported_host')
    expect(parsed.error.message).toContain('orca linear project update add')
  })

  it('passes an unrelated RPC failure through untouched', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_update',
        ok: false,
        error: { code: 'linear_write_unconfirmed', message: 'Write not confirmed' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )

    await main(
      ['linear', 'project', 'update', 'add', 'launch-q3', '--body', 'x', '--json'],
      '/tmp/repo'
    )

    const parsed = JSON.parse(firstLog()) as { error: { code: string } }
    expect(parsed.error.code).toBe('linear_write_unconfirmed')
  })

  it('keeps `linear project update` a help-only group that writes nothing', async () => {
    await main(['linear', 'project', 'update', '--help'], '/tmp/repo')

    const output = firstLog()
    expect(output).toContain('Usage: orca linear project update <command> [options]')
    expect(output).toContain('add')
    expect(output).not.toContain('statuses')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('documents the leaf command flags in its own help without any RPC', async () => {
    await main(['linear', 'project', 'update', 'add', '--help'], '/tmp/repo')

    const output = firstLog()
    expect(output).toContain('orca linear project update add')
    expect(output).toContain('--health')
    expect(output).toContain('--hide-diff')
    expect(output).toContain('--body-file')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('prints the same group help for the bare `linear project update` path', async () => {
    await main(['linear', 'project', 'update'], '/tmp/repo')

    expect(firstLog()).toContain('Usage: orca linear project update <command> [options]')
    expect(callMock).not.toHaveBeenCalled()
    // Why: a bare group path is still an incomplete command — scripts that check
    // the exit code must see failure, not the success of a real command.
    expect(process.exitCode).toBe(1)
  })
})
