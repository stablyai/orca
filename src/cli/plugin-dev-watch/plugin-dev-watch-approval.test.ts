import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import { RuntimeClientError } from '../runtime/types'
import {
  createTerminalConfirm,
  pluginDevWatchConfirmFor,
  type PluginDevWatchConfirm
} from './plugin-dev-watch-approval'
import type { PluginDevWatchEvent } from './plugin-dev-watch-events'
import { runPluginDevWatch, type PluginDevWatchHost } from './plugin-dev-watch-loop'

const KEY = 'acme.notes'
const PATH = '/work/notes'
const FINGERPRINT = 'ap1-0123456789abcdef'
const COMMAND = `orca plugin dev watch ${PATH} --approve ${FINGERPRINT}`

const plugin: PluginHostListEntry = {
  pluginKey: KEY,
  consentFingerprint: 'sha256-x',
  name: 'Notes',
  version: '1.0.0',
  publisher: 'acme',
  status: 'running',
  needsReconsent: false,
  isDev: true,
  devChangeCount: 0,
  official: false,
  bundled: false,
  capabilities: [],
  panels: [],
  commands: [],
  hasWorker: true,
  restarts: 0
}

function approvalRequired(): RuntimeClientError {
  return new RuntimeClientError(
    'approval_required',
    `${KEY} 1.0.0 needs approval before it can run.`,
    {
      pluginKey: KEY,
      name: 'Notes',
      version: '1.0.0',
      action: 'dev-load',
      approvalFingerprint: FINGERPRINT,
      isDev: true,
      grants: {
        execution: 'trusted-worker',
        executionDescription: 'Runs its own code in a separate Node.js process on the Orca host.',
        capabilities: [{ kind: 'git.read', description: 'Read git status.' }],
        contributions: [{ kind: 'panels', name: 'Notes' }]
      },
      why: 'It can run code.',
      command: COMMAND,
      nextSteps: [`To approve, run: ${COMMAND}`]
    }
  )
}

/** The first devLoad needs approval; one with the fingerprint loads. Ctrl-C after the first poll. */
function watch(confirm: PluginDevWatchConfirm | undefined) {
  const events: PluginDevWatchEvent[] = []
  let interrupt: () => void = () => {}
  const devLoad = vi.fn(async (fingerprint?: string) => {
    if (fingerprint !== FINGERPRINT) {
      throw approvalRequired()
    }
    return { path: PATH, pluginKey: KEY, added: true, approval: 'approve-flag' as const, plugin }
  })
  const host: PluginDevWatchHost = {
    refreshTypes: async () => [],
    devLoad,
    list: async () => [plugin],
    logs: async () => ({ pluginKey: KEY, lines: [] }),
    approvalNeeded: async () => null,
    devUnload: vi.fn(async () => {})
  }
  const run = runPluginDevWatch({
    host,
    emit: (event) => events.push(event),
    wait: async () => interrupt(),
    onInterrupt: (listener) => {
      interrupt = listener
      return () => {}
    },
    exitNow: vi.fn(),
    isConnectionLost: () => false,
    ...(confirm ? { confirm } : {})
  })
  return { run, events, devLoad, host }
}

describe('first-load approval prompt', () => {
  it('on yes, loads again with the host fingerprint and keeps watching', async () => {
    const confirm = vi.fn(async (_question: string) => true)
    const { run, events, devLoad, host } = watch(confirm)
    await expect(run).resolves.toBe(0)
    expect(devLoad.mock.calls).toEqual([[undefined], [FINGERPRINT]])
    const question = confirm.mock.calls[0]?.[0] ?? ''
    expect(question).toContain('Approving grants:')
    expect(question).toContain(`${KEY} 1.0.0 (trusted-worker)`)
    expect(question).toContain('  - Read git status.')
    expect(question).toContain('  adds panels: Notes')
    expect(question.endsWith('Approve and load? [y/N] ')).toBe(true)
    expect(events.map((event) => event.type)).toEqual(['loaded', 'unloaded'])
    expect(host.devUnload).toHaveBeenCalledTimes(1)
  })

  it('on no or no answer, fails approval_required with only the re-run command', async () => {
    const confirm = vi.fn(async () => false)
    const { run, devLoad } = watch(confirm)
    await expect(run).rejects.toMatchObject({
      code: 'approval_required',
      message: `Not approved. To approve later, run: ${COMMAND}`,
      data: { command: COMMAND, nextSteps: [] }
    })
    // The grants were just on screen; the error does not print them again.
    await expect(run).rejects.not.toHaveProperty('data.grants')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(devLoad).toHaveBeenCalledTimes(1)
  })

  it('without a prompt (--json or no terminal) fails as before', async () => {
    const { run, devLoad } = watch(undefined)
    await expect(run).rejects.toMatchObject({ code: 'approval_required' })
    expect(devLoad).toHaveBeenCalledTimes(1)
  })

  it('never prompts for a stale fingerprint passed with --approve', async () => {
    const confirm = vi.fn(async () => true)
    const { run, host } = watch(confirm)
    const stale = new RuntimeClientError('approval_stale', 'changed', approvalRequired().data)
    vi.mocked(host.devLoad).mockRejectedValueOnce(stale)
    await expect(run).rejects.toBe(stale)
    expect(confirm).not.toHaveBeenCalled()
  })
})

function terminal(isTTY = true) {
  const input = Object.assign(new PassThrough(), { isTTY })
  const output = Object.assign(new PassThrough(), { isTTY })
  let printed = ''
  output.on('data', (chunk: Buffer) => {
    printed += chunk.toString()
  })
  return { input, output, printed: () => printed }
}

describe('pluginDevWatchConfirmFor', () => {
  it('prompts only when both streams are terminals and --json is off', () => {
    expect(pluginDevWatchConfirmFor(false, terminal())).toBeTypeOf('function')
    expect(pluginDevWatchConfirmFor(true, terminal())).toBeUndefined()
    expect(pluginDevWatchConfirmFor(false, terminal(false))).toBeUndefined()
    const { input } = terminal(false)
    expect(pluginDevWatchConfirmFor(false, { input, output: terminal().output })).toBeUndefined()
  })

  it.each([
    ['y\n', true],
    ['YES\n', true],
    [' yes \n', true],
    ['n\n', false],
    ['\n', false],
    ['sure\n', false]
  ])('reads %j as %s', async (typed, expected) => {
    const streams = terminal()
    const answer = createTerminalConfirm(streams)('Approve and load? [y/N] ')
    streams.input.write(typed)
    await expect(answer).resolves.toBe(expected)
    expect(streams.printed()).toContain('Approve and load? [y/N] ')
  })

  it.each([
    ['end of input', (input: PassThrough) => input.end()],
    ['Ctrl-C', (input: PassThrough) => input.write('\u0003')]
  ])('reads %s as no', async (_name, stop) => {
    const streams = terminal()
    const answer = createTerminalConfirm(streams)('Approve and load? [y/N] ')
    stop(streams.input)
    await expect(answer).resolves.toBe(false)
  })
})
