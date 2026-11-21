import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DELIVERY_SCENARIOS } from './bot-automation-eval-delivery-scenarios'
import {
  installDeliveryUploads,
  serveDeliveries,
  type EvalArtifactInvocation
} from './bot-automation-eval-artifacts'
import { ARTIFACT_HANDLERS } from '../artifacts/artifacts'
import { RuntimeClient } from '../runtime/client'
import {
  normalizeCommandPositionals,
  parseArgs,
  resolveHelpPath,
  validateCommandAndFlags
} from '../arguments/args'
import { ARTIFACT_COMMAND_SPECS } from '../specs/artifacts'
import { REMOTE_ARTIFACT_INPUT_ENV } from '../../shared/artifacts/artifact-cli-bridge'
import { serveWakingThread } from './bot-automation-eval-waking-thread'
import {
  EVAL_BOT,
  type EvalHostState,
  type EvalOutcome,
  type EvalWrite
} from './bot-automation-eval-host'

const report =
  '<table><tr><td>us-east</td><td>0.4%</td></tr><tr><td>eu-west</td><td>1.1%</td></tr><tr><td>ap-south</td><td>2.3%</td></tr></table>'
const target = 'slack:T0EVAL:C0EXPORTS:1793437200.000500'
const outcome = (writes: EvalWrite[] = [], reply = 'Posted.'): EvalOutcome => ({
  writes,
  reply,
  commands: [],
  ownerTools: []
})
const grade = (id: string, value: EvalOutcome) =>
  DELIVERY_SCENARIOS.find((scenario) => scenario.id === id)!.grade(value)
const fallback = `I couldn't attach the file. ${report}`
const posted = (text: string): EvalWrite => ({
  method: 'connector.reply',
  params: { text },
  result: { target }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('grades the actual report in final and explicit replies, requiring a failure explanation', () => {
  for (const id of ['delivery-sharing-off-attaches', 'delivery-files-refused-gives-content']) {
    expect(grade(id, outcome([], fallback))).toEqual([])
    expect(grade(id, outcome([posted(fallback)]))).toEqual([])
    expect(grade(id, outcome([], fallback.replaceAll('<td>', '<td class="p-2">')))).toEqual([])
    expect(grade(id, outcome([posted(report)], "Couldn't attach; posted the content."))).toEqual([])
    expect(
      grade(id, outcome([], 'Cannot attach: us-east 0%, eu-west 0%, ap-south 0%.'))
    ).not.toEqual([])
    expect(grade(id, outcome([], report))).not.toEqual([])
    expect(
      grade(id, outcome([{ ...posted(fallback), result: { target: 'slack:elsewhere' } }]))
    ).not.toEqual([])
  }
})

it('matches shared report bytes and the returned link to the recipient-visible reply', () => {
  const share: EvalWrite = {
    method: 'artifacts.share',
    params: { content: report },
    result: { shareUrl: 'https://share.onorca.dev/a/eval-report' }
  }
  const reply = posted('Read https://share.onorca.dev/a/eval-report')
  expect(grade('delivery-share-link', outcome([share, reply]))).toEqual([])
  expect(grade('delivery-share-link', outcome([share]))).not.toEqual([])
  expect(
    grade('delivery-share-link', outcome([{ ...share, params: { content: 'empty' } }, reply]))
  ).not.toEqual([])
  expect(
    grade(
      'delivery-share-link',
      outcome([{ ...share, result: { shareUrl: 'https://wrong.example' } }, reply])
    )
  ).not.toEqual([])
})

it('rejects refused-share retries at CLI preflight and every supported local-path family', () => {
  const retried = outcome(
    [
      {
        method: 'artifacts.attempt',
        params: { invocationId: 'first', phase: 'preflight' },
        result: { refusal: 'artifact_sharing_disabled' }
      },
      {
        method: 'artifacts.attempt',
        params: { invocationId: 'retry', phase: 'preflight' },
        result: { refusal: 'artifact_sharing_disabled' }
      }
    ],
    fallback
  )
  retried.commands = [
    ['artifacts', 'share', 'r.html'],
    ['artifacts', 'share', 'r.html']
  ]
  expect(grade('delivery-files-refused-gives-content', retried)).not.toEqual([])
  for (const path of [
    '~/r.html',
    '$HOME/r.html',
    '/Users/ada/r.html',
    '/home/ada/r.html',
    '/root/r.html',
    '/tmp/r.html',
    '/private/r.html',
    '/var/folders/r.html',
    '/var/tmp/r.html',
    '/mnt/c/Users/ada/r.html',
    'C:\\Users\\ada\\r.html',
    'file:///tmp/r.html'
  ]) {
    expect(
      grade('delivery-files-refused-gives-content', outcome([], `${fallback} ${path}`))
    ).not.toEqual([])
  }
})

it('records actual refusal per invocation and allows usage-error recovery before that refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-share-refusal-'))
  const state: EvalHostState = {
    bots: [{ ...EVAL_BOT, agent: 'claude' }],
    automations: [],
    repos: [],
    timezone: 'UTC',
    artifactSharing: 'off'
  }
  const writes: EvalWrite[] = []
  const delivered = outcome(writes, fallback)
  const io = {
    record: (entry: Record<string, unknown>) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery adapters record EvalWrites with kind.
      writes.push(entry as EvalWrite)
    },
    save: () => {}
  }
  let invocation: EvalArtifactInvocation = { id: 'unused', argv: [] }
  const client = new RuntimeClient(dir, 1000, null, null, 'orca')
  vi.stubEnv(REMOTE_ARTIFACT_INPUT_ENV, undefined)
  vi.spyOn(client, 'call').mockImplementation(async <TResult>(method: string, params?: unknown) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real CLI sends object params or none to these adapters.
    const result = serveDeliveries(
      state,
      method,
      (params ?? {}) as Record<string, unknown>,
      io,
      invocation
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in answers in the called method's shape.
    return { id: 'eval', ok: true, result: result as TResult, _meta: { runtimeId: 'eval' } }
  })
  const run = async (id: string, argv: string[]) => {
    invocation = { id, argv }
    delivered.commands.push(argv)
    const parsed = normalizeCommandPositionals(
      ARTIFACT_COMMAND_SPECS,
      parseArgs(
        argv,
        ARTIFACT_COMMAND_SPECS.map((spec) => spec.path),
        ARTIFACT_COMMAND_SPECS
      )
    )
    if (resolveHelpPath(parsed) !== null) {
      return
    }
    validateCommandAndFlags(ARTIFACT_COMMAND_SPECS, parsed)
    await ARTIFACT_HANDLERS[parsed.commandPath.join(' ')]!({
      flags: parsed.flags,
      client,
      cwd: dir,
      json: true
    })
  }
  try {
    await expect(run('usage', ['artifacts', 'share'])).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    await run('help', ['artifacts', 'share', '--help'])
    await run('help-path', ['help', 'artifacts', 'share'])
    await run('help-value', ['--json', 'artifacts', 'share', '--help=false'])
    await expect(run('refused', ['artifacts', 'share', 'r.html'])).rejects.toMatchObject({
      code: 'artifact_sharing_disabled'
    })
    await expect(
      run('invalid', ['artifacts', 'share', 'r.html', '--unknown-flag'])
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(run('later-usage', ['artifacts', 'share'])).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(grade('delivery-files-refused-gives-content', delivered)).toEqual([])
    expect(writes).toContainEqual({
      kind: 'write',
      method: 'artifacts.attempt',
      params: {
        invocationId: 'refused',
        argv: ['artifacts', 'share', 'r.html'],
        phase: 'preflight'
      },
      result: { refusal: 'artifact_sharing_disabled' }
    })
    await expect(
      run('retry', ['--json', 'artifacts', 'share', '--file=r.html'])
    ).rejects.toMatchObject({ code: 'artifact_sharing_disabled' })
    expect(grade('delivery-files-refused-gives-content', delivered)).not.toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('does not count preflight and publication in one invocation as separate retries', () => {
  const delivered = outcome(
    [
      {
        method: 'artifacts.attempt',
        params: { invocationId: 'first', phase: 'preflight' },
        result: { refusal: null }
      },
      {
        method: 'artifacts.attempt',
        params: { invocationId: 'first', phase: 'publish' },
        result: { refusal: 'artifact_sharing_disabled' }
      }
    ],
    fallback
  )
  expect(grade('delivery-files-refused-gives-content', delivered)).toEqual([])
  delivered.writes.push({
    method: 'artifacts.attempt',
    params: { invocationId: 'retry', phase: 'preflight' },
    result: { refusal: null }
  })
  expect(grade('delivery-files-refused-gives-content', delivered)).not.toEqual([])
})

it('requires uploaded bytes matched to the staged IDs and destination before the final file post', async () => {
  const state: EvalHostState = {
    bots: [{ ...EVAL_BOT, agent: 'claude' }],
    automations: [],
    repos: [],
    timezone: 'UTC',
    conversation: { source: 'slack', title: 'error rates' }
  }
  const writes: EvalWrite[] = []
  const io = {
    record: (entry: Record<string, unknown>) => {
      const { method, params, result } = entry
      if (typeof method === 'string' && params && typeof params === 'object') {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stand-in write records have object params.
        writes.push({ method, params: params as Record<string, unknown>, result })
      }
    },
    save: () => {}
  }
  vi.stubGlobal('fetch', vi.fn())
  installDeliveryUploads(io)
  const staged = serveWakingThread(
    state,
    'reply',
    undefined,
    {
      args: {
        stage: true,
        upload: { name: 'report.html', size: Buffer.byteLength(report) },
        postId: 'file-1'
      }
    },
    io
  )
  expect(staged).toMatchObject({ ok: true, result: { upload: { url: expect.any(String) } } })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: response shape checked above.
  const uploadUrl = (staged as { result: { upload: { url: string } } }).result.upload.url
  await fetch(uploadUrl, {
    method: 'POST',
    body: new Blob([report])
  })
  serveWakingThread(
    state,
    'reply',
    undefined,
    { args: { files: ['file-1'], postId: 'post-1' } },
    io
  )
  expect(grade('delivery-sharing-off-attaches', outcome(writes))).toEqual([])
  expect(
    grade(
      'delivery-sharing-off-attaches',
      outcome(writes.filter((write) => write.method !== 'connector.upload'))
    )
  ).not.toEqual([])
  expect(
    grade(
      'delivery-sharing-off-attaches',
      outcome(
        writes.map((write) =>
          write.method === 'connector.upload'
            ? { ...write, params: { postId: 'other-file' } }
            : write
        )
      )
    )
  ).not.toEqual([])
  expect(
    grade(
      'delivery-sharing-off-attaches',
      outcome(
        writes.map((write) =>
          write.method === 'connector.stage'
            ? { ...write, result: { target: 'slack:elsewhere' } }
            : write
        )
      )
    )
  ).not.toEqual([])
  expect(grade('delivery-sharing-off-attaches', outcome(writes.toReversed()))).not.toEqual([])
  expect(
    grade(
      'delivery-sharing-off-attaches',
      outcome(
        writes.map((write) => {
          if (write.method === 'connector.stage') {
            return { ...write, params: { args: { postId: 'file-1' } } }
          }
          return write.method === 'connector.upload'
            ? { ...write, result: { text: report } }
            : write
        })
      )
    )
  ).not.toEqual([])
})

it('delivers the report to the seeded item and separately accepts readable fallback after refusal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-delivery-'))
  const path = join(dir, 'report.html')
  writeFileSync(path, report)
  const scenario = DELIVERY_SCENARIOS.find((entry) => entry.id === 'delivery-chat-sharing-off')!
  const state: EvalHostState = {
    bots: [{ ...EVAL_BOT, agent: 'claude' }],
    automations: [],
    repos: [],
    timezone: 'UTC',
    ...scenario.state
  }
  const writes: EvalWrite[] = []
  const io = {
    record: (entry: Record<string, unknown>) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: serveDeliveries records an EvalWrite with kind.
      writes.push(entry as EvalWrite)
    },
    save: () => {}
  }
  try {
    serveDeliveries(state, 'bots.items.comment', { item: '42', files: [path] }, io)
    expect(scenario.grade(outcome(writes))).toEqual([])
    expect(
      scenario.grade(
        outcome(
          writes.map((write) => ({
            ...write,
            result: { item: 43, files: [{ name: 'report.html', text: report }] }
          }))
        )
      )
    ).not.toEqual([])
    expect(() =>
      serveDeliveries(state, 'bots.items.comment', { item: '43', files: [path] }, io)
    ).toThrow('There is no item 43.')
    expect(() =>
      serveDeliveries(
        { ...state, filesRefused: true },
        'bots.items.comment',
        { item: '42', files: [path] },
        io
      )
    ).toThrow('The item did not take the file.')
    expect(grade('delivery-chat-files-refused-gives-content', outcome([], fallback))).toEqual([])
    writeFileSync(path, 'no report')
    writes.length = 0
    serveDeliveries(state, 'bots.items.comment', { item: '42', files: [path] }, io)
    expect(scenario.grade(outcome(writes))).not.toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
