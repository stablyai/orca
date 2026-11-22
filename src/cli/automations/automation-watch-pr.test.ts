import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs/index'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import type { RuntimeClient } from '../runtime/client'
import { AUTOMATION_HANDLERS } from './automations'

const NOW = Date.parse('2030-01-01T12:00:00.000Z')
const RULES = [
  'ci_finished',
  'pr_conflicted',
  'pr_merged',
  'pr_closed',
  'review',
  'review_comment',
  'comment'
].map((event) => ({ source: 'github', event, subject: 'stablyai/orca#482' }))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The `automation.create` params `orca automations watch-pr <argv>` sends a host whose bot has GitHub. */
async function watchPr(
  argv: string[],
  github: unknown = { login: 'octo' }
): Promise<Record<string, unknown>> {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(['automations', 'watch-pr', ...argv], paths, COMMAND_SPECS)
  )
  const bot = { id: 'bot-1', name: 'ranger', agent: 'claude', github }
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) =>
    method === 'bots.list'
      ? { result: { bots: [bot], threadReplies: true, githubEvents2: true } }
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
  it('creates one wait on every next-step event of the pull request, due in 2 hours', async () => {
    const params = await watchPr(['https://github.com/stablyai/orca/pull/482', '--bot', 'ranger'])
    expect(params.on).toMatchObject(RULES)
    expect(params.on).toHaveLength(RULES.length)
    expect(params.once).toEqual({ by: Date.parse('2030-01-01T14:00:00.000Z') })
    expect(params.name).toBe('PR stablyai/orca#482')
    expect(params.prompt).toMatch(/deadline came first.*read the pull request fresh/)
    expect(params.bot).toMatchObject({ botId: 'bot-1', resultsTo: 'chat' })
  })

  it('takes --for or --by for the deadline, and the caller name and prompt', async () => {
    const forty = await watchPr([
      'stablyai/orca#482',
      '--bot',
      'ranger',
      '--for',
      '1h30m',
      '--name',
      'Watch',
      '--prompt',
      'Fix attempt 1 of 2'
    ])
    expect(forty.once).toEqual({ by: Date.parse('2030-01-01T13:30:00.000Z') })
    expect(forty.name).toBe('Watch')
    expect(forty.prompt).toMatch(/^Fix attempt 1 of 2\n\n/)
    const by = await watchPr([
      'stablyai/orca#482',
      '--bot',
      'ranger',
      '--by',
      '2030-01-02T00:00:00Z'
    ])
    expect(by.once).toEqual({ by: Date.parse('2030-01-02T00:00:00Z') })
  })

  it('refuses a bot without GitHub, and what is not one pull request or one deadline', async () => {
    const refused = (argv: string[]) => watchPr(['--bot', 'ranger', ...argv])
    await expect(watchPr(['a/b#1', '--bot', 'ranger'], null)).rejects.toThrow(/no GitHub connector/)
    await expect(refused(['stablyai/orca'])).rejects.toThrow(/one pull request/)
    await expect(refused(['https://github.com/a/b/issues/1'])).rejects.toThrow(/one pull request/)
    await expect(refused(['a/b#1', '--for', '2d'])).rejects.toThrow(/--for takes/)
    await expect(refused(['a/b#1', '--for', '0m'])).rejects.toThrow(/--for takes/)
    await expect(refused(['a/b#1', '--for', '1h', '--by', '2030-01-02T00:00:00Z'])).rejects.toThrow(
      /not both/
    )
  })
})
