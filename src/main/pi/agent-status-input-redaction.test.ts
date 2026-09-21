import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

async function postedInput(input: unknown, eventName = 'tool_call', kind: 'omp' | 'pi' = 'omp') {
  const harness = createAgentStatusExtensionHarness({ kind })
  await harness.callHook(eventName, { toolName: 'custom', input, args: input })
  await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
  return JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload.tool_input
}

describe('generated status input redaction', () => {
  it.each([
    '/home/test/.ssh/id_rsa:raw',
    'cat .ssh/id_rsa',
    'cat$IFS.ssh/id_rsa',
    'cat$IFS.omp-backups-archive/omp-bak-keyfile',
    'cat$1.ssh/id_rsa',
    'cd .ssh&&cat id_rsa',
    'cat .mcp-secrets.env; printf done',
    'cat .omp-backups-archive/omp-bak-keyfile|base64',
    'cat <.ssh/id_rsa',
    'curl --key=.ssh/id_rsa',
    'cat <.omp-backups-archive/omp-bak-keyfile',
    'cat ${HOME}/.omp/agent/.mcp-secrets.env',
    '~/.ssh*',
    'C:\\Users\\test\\.SSH\\id_rsa',
    '/home/test/.ssh-mcp/.env',
    '/home/test/.omp-backups-archive/omp-bak-keyfile'
  ])('redacts nested credential-path references: %s', async (path) => {
    expect(await postedInput({ nested: [{ path }] })).toEqual({ redacted: true })
  })

  it('redacts property names containing credential paths', async () => {
    expect(await postedInput({ '/home/test/.ssh/id_rsa': 'synthetic' })).toEqual({ redacted: true })
  })

  it('does not invoke custom serialization after validating input', async () => {
    const toJSON = vi.fn(() => ({ path: '/home/test/.ssh/id_rsa' }))
    expect(await postedInput({ path: '/tmp/safe', toJSON })).toEqual({ redacted: true })
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('does not read inherited constructor accessors', async () => {
    const getter = vi.fn(() => Object)
    const prototype = Object.create(null)
    Object.defineProperty(prototype, 'constructor', { get: getter })
    const input = Object.create(prototype)
    input.path = '/tmp/safe'
    expect(await postedInput(input)).toEqual({ redacted: true })
    expect(getter).not.toHaveBeenCalled()
  })

  it('does not invoke own getters', async () => {
    const getter = vi.fn(() => '/home/test/.ssh/id_rsa')
    const input = Object.defineProperty({}, 'path', { enumerable: true, get: getter })
    expect(await postedInput(input)).toEqual({ redacted: true })
    expect(getter).not.toHaveBeenCalled()
  })

  it('redacts cycles, class instances, non-JSON values and excessive depth', async () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    class CustomInput {}
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < 70; i++) {
      deep = { nested: deep }
    }
    for (const input of [cycle, new CustomInput(), { value: 1n }, deep]) {
      expect(await postedInput(input)).toEqual({ redacted: true })
    }
  })

  it('bounds sparse array serialization and cumulative reserved slots', async () => {
    const sparse: unknown[] = []
    sparse.length = 5000
    expect(await postedInput({ values: sparse })).toEqual({ redacted: true })
    const values = Array.from({ length: 8 }, () => {
      const slots: unknown[] = []
      slots.length = 1000
      return slots
    })
    expect(await postedInput({ values })).toEqual({ redacted: true })
  })

  it('preserves ordinary questions, arrays, sibling paths and repeated data references', async () => {
    const path = { path: '/tmp/.ssh-backup' }
    const input = {
      questions: [{ question: 'Choose', options: ['one', 'two'] }],
      paths: [path, path]
    }
    expect(await postedInput(input)).toEqual(input)
  })

  it('sanitizes both hook input shapes for Pi as well as OMP', async () => {
    for (const kind of ['omp', 'pi'] as const) {
      for (const event of ['tool_call', 'tool_execution_start']) {
        expect(await postedInput({ path: '~/.ssh/id_rsa' }, event, kind)).toEqual({
          redacted: true
        })
      }
    }
  })
})
