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

const WRITE_ID_V4 = '6d1c5a7e-3ac8-4f75-b9dc-f7af49d91234'
const WRITE_ID_V1 = '123e4567-e89b-12d3-a456-426614174000'
const WRITE_TIMEOUT = { timeoutMs: 75_000 }
const CREATE = ['linear', 'project', 'create']

function createResult(metaOverrides: Record<string, unknown> = {}): unknown {
  return {
    project: {
      id: 'project-1',
      name: 'Payments V2',
      slugId: 'payments-v2',
      url: 'https://linear.app/acme/project/payments-v2-8f3a'
    },
    meta: {
      workspaceId: 'workspace-1',
      writeId: WRITE_ID_V4,
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

function sentRequest(): Record<string, unknown> {
  return callMock.mock.calls[0][1] as Record<string, unknown>
}

describe('orca linear project create', () => {
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

  it('sends the minimal create request with references as user input strings', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main([...CREATE, '--name', '  Payments V2  ', '--team', 'ENG'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'linear.agentProjectCreate',
      {
        name: 'Payments V2',
        teams: ['ENG'],
        description: undefined,
        content: undefined,
        status: undefined,
        lead: undefined,
        members: undefined,
        labels: undefined,
        priority: undefined,
        startDate: undefined,
        targetDate: undefined,
        color: undefined,
        icon: undefined,
        writeId: undefined,
        workspaceId: undefined
      },
      WRITE_TIMEOUT
    )
  })

  it('collects repeated --team, --member and --label for this command', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main(
      [
        ...CREATE,
        '--name',
        'Payments V2',
        '--team',
        'ENG',
        '--team',
        'DESIGN',
        '--member',
        'ada',
        '--member',
        'grace',
        '--label',
        'Platform',
        '--label=Q3'
      ],
      '/tmp/repo'
    )

    expect(sentRequest()).toMatchObject({
      teams: ['ENG', 'DESIGN'],
      members: ['ada', 'grace'],
      labels: ['Platform', 'Q3']
    })
  })

  it('sends every optional reference and scalar field verbatim', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main(
      [
        ...CREATE,
        '--name',
        'Payments V2',
        '--team',
        'ENG',
        '--description',
        'Card + ACH rails',
        '--content',
        '## Overview',
        '--status',
        'In Progress',
        '--lead',
        'me',
        '--priority',
        'high',
        '--start-date',
        '2026-07-01',
        '--target-date',
        '2026-10-01',
        '--color',
        '#4EA7FC',
        '--icon',
        'Rocket',
        '--write-id',
        WRITE_ID_V4,
        '--workspace',
        'workspace-1'
      ],
      '/tmp/repo'
    )

    expect(sentRequest()).toMatchObject({
      description: 'Card + ACH rails',
      content: '## Overview',
      status: 'In Progress',
      lead: 'me',
      priority: 2,
      startDate: '2026-07-01',
      targetDate: '2026-10-01',
      color: '#4EA7FC',
      icon: 'Rocket',
      writeId: WRITE_ID_V4,
      workspaceId: 'workspace-1'
    })
  })

  it('maps --priority none to 0 instead of dropping it as falsy', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main([...CREATE, '--name', 'P', '--team', 'ENG', '--priority', 'none'], '/tmp/repo')

    expect(sentRequest().priority).toBe(0)
  })

  it('keeps empty description and content as meaningful values', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main(
      [...CREATE, '--name', 'P', '--team', 'ENG', '--description=', '--content='],
      '/tmp/repo'
    )

    expect(sentRequest()).toMatchObject({ description: '', content: '' })
  })

  it('normalizes CRLF and lone CR in description and content without trimming', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main(
      [...CREATE, '--name', 'P', '--team', 'ENG', '--description= a\r\nb ', '--content=x\ry'],
      '/tmp/repo'
    )

    expect(sentRequest()).toMatchObject({ description: ' a\nb ', content: 'x\ny' })
  })

  it('requires --name', async () => {
    await main([...CREATE, '--team', 'ENG'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Missing required --name')
  })

  it('rejects a whitespace-only --name', async () => {
    await main([...CREATE, '--name', '   ', '--team', 'ENG'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--name must not be blank')
  })

  it('requires at least one --team', async () => {
    await main([...CREATE, '--name', 'Payments V2'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Missing required --team')
  })

  it('rejects a non-v4 --write-id with linear_invalid_write_id and no RPC', async () => {
    await main(
      [...CREATE, '--name', 'P', '--team', 'ENG', '--write-id', WRITE_ID_V1, '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = JSON.parse(firstLog()) as { error: { code: string; message: string } }
    expect(printed.error.code).toBe('linear_invalid_write_id')
    expect(printed.error.message).toContain('UUID v4')
  })

  it('leaves the generic UUID contract in place for project update add', async () => {
    queueFixtures(
      callMock,
      okFixture('req_update', {
        projectUpdate: {
          id: 'update-1',
          url: 'https://linear.app/acme/project/payments-v2-8f3a#update-1',
          health: 'onTrack',
          createdAt: '2026-06-01T00:00:00.000Z'
        },
        project: {
          id: 'project-1',
          name: 'Payments V2',
          slugId: 'payments-v2',
          url: 'https://linear.app/acme/project/payments-v2-8f3a'
        },
        meta: {
          workspaceId: 'workspace-1',
          bodyChars: 1,
          writeId: WRITE_ID_V1,
          deduplicated: false
        }
      })
    )

    await main(
      [
        'linear',
        'project',
        'update',
        'add',
        'payments-v2',
        '--body',
        'x',
        '--write-id',
        WRITE_ID_V1
      ],
      '/tmp/repo'
    )

    expect(callMock.mock.calls[0][1]).toMatchObject({ writeId: WRITE_ID_V1 })
  })

  it('rejects an impossible calendar date before any RPC', async () => {
    await main(
      [...CREATE, '--name', 'P', '--team', 'ENG', '--target-date', '2026-02-30'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--target-date must be a real calendar date')
  })

  it('rejects a non-ISO start date before any RPC', async () => {
    await main(
      [...CREATE, '--name', 'P', '--team', 'ENG', '--start-date', '07/01/2026'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--start-date must use YYYY-MM-DD')
  })

  it('rejects a malformed --color before any RPC', async () => {
    await main([...CREATE, '--name', 'P', '--team', 'ENG', '--color', '4EA7FC'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--color must be #RRGGBB')
  })

  it('requires exactly one of --content and --content-file', async () => {
    await main(
      [
        ...CREATE,
        '--name',
        'P',
        '--team',
        'ENG',
        '--content',
        'x',
        '--content-file',
        'overview.md'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('Use either --content or --content-file, not both')
  })

  it('reads --content-file - from stdin and normalizes line endings', async () => {
    const stdin = mockStdin(false, ['line one\r\n', 'line two\rline three'])
    queueFixtures(callMock, okFixture('req_create', createResult()))

    try {
      await main([...CREATE, '--name', 'P', '--team', 'ENG', '--content-file', '-'], '/tmp/repo')
    } finally {
      stdin.restore()
    }

    expect(sentRequest().content).toBe('line one\nline two\nline three')
  })

  it('rejects --content-file - when stdin is a TTY', async () => {
    const stdin = mockStdin(true, [])

    try {
      await main([...CREATE, '--name', 'P', '--team', 'ENG', '--content-file', '-'], '/tmp/repo')
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('stdin is a TTY')
  })

  it('rejects a bad --write-id before consuming stdin', async () => {
    const stdin = mockStdin(false, ['overview from stdin'])

    try {
      await main(
        [...CREATE, '--name', 'P', '--team', 'ENG', '--content-file', '-', '--write-id', 'nope'],
        '/tmp/repo'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain('--write-id must be a UUID v4')
  })

  it('rejects over-cap content with linear_body_too_large and no RPC', async () => {
    await main(
      [
        ...CREATE,
        '--name',
        'P',
        '--team',
        'ENG',
        `--content=${'a'.repeat(LINEAR_WRITE_BODY_CAP + 1)}`
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(firstError()).toContain(`Linear body must be at most ${LINEAR_WRITE_BODY_CAP}`)
  })

  it('rejects an over-cap description with linear_body_too_large and no RPC', async () => {
    await main(
      [
        ...CREATE,
        '--name',
        'P',
        '--team',
        'ENG',
        `--description=${'a'.repeat(LINEAR_WRITE_BODY_CAP + 1)}`,
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = JSON.parse(firstLog()) as { error: { code: string } }
    expect(printed.error.code).toBe('linear_body_too_large')
  })

  it('rejects --workspace all with linear_invalid_workspace and no RPC', async () => {
    await main(
      [...CREATE, '--name', 'P', '--team', 'ENG', '--workspace', 'all', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = JSON.parse(firstLog()) as { error: { code: string } }
    expect(printed.error.code).toBe('linear_invalid_workspace')
  })

  it('emits the full result envelope in --json mode', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main([...CREATE, '--name', 'Payments V2', '--team', 'ENG', '--json'], '/tmp/repo')

    const printed = JSON.parse(firstLog()) as {
      ok: boolean
      result: {
        project: { id: string; name: string; slugId: string; url: string }
        meta: { workspaceId: string; writeId: string; deduplicated: boolean }
      }
    }
    expect(printed.ok).toBe(true)
    expect(printed.result.project).toEqual({
      id: 'project-1',
      name: 'Payments V2',
      slugId: 'payments-v2',
      url: 'https://linear.app/acme/project/payments-v2-8f3a'
    })
    expect(printed.result.meta).toEqual({
      workspaceId: 'workspace-1',
      writeId: WRITE_ID_V4,
      deduplicated: false
    })
  })

  it('renders a human summary naming the project, id and write id', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main([...CREATE, '--name', 'Payments V2', '--team', 'ENG'], '/tmp/repo')

    const output = firstLog()
    expect(output).toContain('Created Linear project Payments V2 (payments-v2)')
    expect(output).toContain('Project id: project-1')
    expect(output).toContain(`Write id: ${WRITE_ID_V4}`)
    expect(output).not.toContain('Deduplicated')
  })

  it('clearly marks a deduplicated create in human output', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult({ deduplicated: true })))

    await main(
      [...CREATE, '--name', 'Payments V2', '--team', 'ENG', '--write-id', WRITE_ID_V4],
      '/tmp/repo'
    )

    const output = firstLog()
    expect(output).toContain('Deduplicated Linear project Payments V2 (payments-v2)')
    expect(output).toContain(
      'Deduplicated: the pinned --write-id already created this project; nothing new was created.'
    )
    expect(output).not.toContain('Created Linear project')
  })

  it('rewrites method_not_found into an upgrade instruction', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_create',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method linear.agentProjectCreate' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )

    await main([...CREATE, '--name', 'P', '--team', 'ENG'], '/tmp/repo')

    const stderr = firstError()
    expect(stderr).toContain('This Orca host does not support `orca linear project create`.')
    expect(stderr).not.toContain('method_not_found')
    expect(process.exitCode).toBe(1)
  })

  it('documents the create flags in its own help without any RPC', async () => {
    await main([...CREATE, '--help'], '/tmp/repo')

    const output = firstLog()
    expect(output).toContain('orca linear project create')
    expect(output).toContain('--team')
    expect(output).toContain('--content-file')
    expect(output).toContain('--member')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })
})
