import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs/index'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import type { RuntimeClient } from '../runtime/client'
import { AUTOMATION_HANDLERS } from './automations'

const NOW = Date.parse('2030-01-01T12:00:00.000Z')
const PR = 'stablyai/orca#482'
const OTHER_RULES = [
  'pr_conflicted',
  'pr_merged',
  'pr_closed',
  'review',
  'review_comment',
  'comment'
]

const rules = (events: string[]) =>
  events.map((event) => ({ source: 'github', event, subject: PR }))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Host = { github?: unknown; ciFinished?: boolean }

/** The `automation.create` params `orca automations watch-pr <argv>` sends a host whose bot has
 *  GitHub, on an Orca Cloud that sends github.ci_finished unless the host says otherwise. */
async function watchPr(argv: string[], host: Host = {}): Promise<Record<string, unknown>> {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(['automations', 'watch-pr', ...argv], paths, COMMAND_SPECS)
  )
  const github = 'github' in host ? host.github : { login: 'octo' }
  const bot = { id: 'bot-1', name: 'ranger', agent: 'claude', github }
  const listing = {
    bots: [bot],
    threadReplies: true,
    githubEvents2: true,
    githubCiFinished: host.ciFinished ?? true
  }
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) =>
    method === 'bots.list'
      ? { result: listing }
      : { result: { automation: { id: 'a1', ...params } } }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path only calls client.call and reads isRemote.
  const client = { call, isRemote: false } as unknown as RuntimeClient
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await AUTOMATION_HANDLERS['automations watch-pr']({
    flags: parsed.flags,
    client,
    cwd: '/',
    json: true
  })
  const created = call.mock.calls.find(([method]) => method === 'automation.create')
  return created?.[1] ?? {}
}

describe('automations watch-pr', () => {
  it('creates one wait on ci_finished and every other next-step event, due in 2 hours', async () => {
    const params = await watchPr(['https://github.com/stablyai/orca/pull/482', '--bot', 'ranger'])
    expect(params.on).toMatchObject(rules(['ci_finished', ...OTHER_RULES]))
    expect(params.on).toHaveLength(7)
    expect(params.once).toEqual({ by: Date.parse('2030-01-01T14:00:00.000Z') })
    expect(params.name).toBe(`PR ${PR}`)
    expect(params.prompt).toMatch(/deadline woke you, read it fresh with gh/)
    expect(params.prompt).not.toMatch(/deadline came first/)
    expect(params.bot).toMatchObject({ botId: 'bot-1', resultsTo: 'chat' })
  })

  it('waits on ci_passed and ci_failed where the Orca Cloud does not send ci_finished', async () => {
    const params = await watchPr([PR, '--bot', 'ranger'], { ciFinished: false })
    expect(params.on).toMatchObject(rules(['ci_passed', 'ci_failed', ...OTHER_RULES]))
    expect(params.on).toHaveLength(8)
  })

  it('takes a pull request tab link, --for or --by, and the caller name and prompt', async () => {
    const forty = await watchPr([
      'http://www.github.com/stablyai/orca/pull/482/checks?x=1',
      '--bot',
      'ranger',
      '--for',
      '1h30m',
      '--name',
      'Watch',
      '--prompt',
      'Fix attempt 1 of 2'
    ])
    expect(forty.on).toMatchObject(rules(['ci_finished', ...OTHER_RULES]))
    expect(forty.once).toEqual({ by: Date.parse('2030-01-01T13:30:00.000Z') })
    expect(forty.name).toBe('Watch')
    expect(forty.prompt).toMatch(
      /^Fix attempt 1 of 2\n\n.*deadline came first.*read stablyai\/orca#482 fresh/
    )
    const by = await watchPr([PR, '--bot', 'ranger', '--by', '2030-01-02T00:00:00Z'])
    expect(by.once).toEqual({ by: Date.parse('2030-01-02T00:00:00Z') })
  })

  it('refuses a bot without GitHub, and what is not one pull request or one deadline', async () => {
    await expect(watchPr([PR, '--bot', 'ranger'], { github: null })).rejects.toThrow(
      /no GitHub connector/
    )
    await expect(watchPr([PR])).rejects.toThrow(/^watch-pr needs --bot <name>$/)
    const refused = (argv: string[]) => watchPr(['--bot', 'ranger', ...argv])
    for (const pr of ['stablyai/orca', 'a/b#0', 'https://github.com/a/b/issues/1']) {
      await expect(refused([pr])).rejects.toThrow(/one pull request/)
    }
    for (const length of ['2d', '0m', '9000h', `${'9'.repeat(400)}h`]) {
      await expect(refused(['a/b#1', '--for', length])).rejects.toThrow(/--for takes/)
    }
    await expect(refused(['a/b#1', '--for='])).rejects.toThrow(/Missing value for --for/)
    await expect(refused(['a/b#1', '--by=', '--for', '45m'])).rejects.toThrow(
      /Missing value for --by/
    )
    await expect(refused(['a/b#1', '--for', '1h', '--by', '2030-01-02T00:00:00Z'])).rejects.toThrow(
      /not both/
    )
  })
})
