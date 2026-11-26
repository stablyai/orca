import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_RUNTIME_CAPABILITIES } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { getPlatformUserDataPath } from '../../runtime/profile/metadata'
import type * as ClientModule from '../../runtime/client'
import type * as HostFlagModule from '../../hosts/execution-host-flag'
import type { RuntimeRpcSuccess } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

// Each Orca a command can reach keeps its own receipt ledger: the original lands in one of them,
// and the recovery commands it prints must ask that same one after a one-shot assignment expires.
type Send = { ledger: string; requestId: string }
const { ledgers, sends, fixture } = vi.hoisted(() => {
  /** Every committed send, retries included, with the Orca it reached. */
  const sent: Send[] = []
  return {
    ledgers: new Map<string, Set<string>>(),
    sends: sent,
    fixture: { nextSendUnsent: false }
  }
})

vi.mock('../../runtime/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ClientModule>()
  const { RuntimeClientError } = await import('../../runtime/connection/types.js')
  const { attachMutationRecovery } =
    await import('../../runtime/connection/client-error-recovery.js')
  type Args = ConstructorParameters<typeof actual.RuntimeClient>
  /** The real client's route selection, with each reachable Orca played by an in-memory ledger. */
  class LedgerClient extends actual.RuntimeClient {
    private readonly ledgerKey: string
    private readonly conflict: boolean
    private readonly command: string[]
    constructor(...args: Args) {
      super(...args)
      // The same defaults the real constructor applies to an omitted selection.
      const pairing =
        args[2] === undefined
          ? (process.env.ORCA_PAIRING_CODE ?? process.env.ORCA_REMOTE_PAIRING ?? null)
          : args[2]
      // As resolvePairedConnection does, both selections together refuse before any Orca is asked.
      this.conflict = Boolean(pairing && this.environmentSelector)
      this.ledgerKey = pairing
        ? `pairing:${pairing}`
        : this.environmentSelector
          ? `environment:${this.environmentSelector}`
          : `profile:${this.userDataPath}`
      this.command = ['orca', ...(args[5] ?? [])]
    }

    override async call<TResult>(
      method: string,
      params?: unknown,
      options?: { orchestrationRequestId?: string; orchestrationReplayOnly?: true }
    ): Promise<RuntimeRpcSuccess<TResult>> {
      if (this.conflict) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Use either --pairing-code or --environment, not both.'
        )
      }
      const ledger = ledgers.get(this.ledgerKey) ?? new Set<string>()
      ledgers.set(this.ledgerKey, ledger)
      const reply = (result: unknown): RuntimeRpcSuccess<TResult> => ({
        id: 'rpc',
        ok: true,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each handler under test reads only the fields this fixture returns for its method.
        result: result as TResult,
        _meta: { runtimeId: this.ledgerKey }
      })
      if (method === 'status.get') {
        return reply({ capabilities: ORCHESTRATION_RUNTIME_CAPABILITIES })
      }
      if (method === 'orchestration.requestShow') {
        const request =
          typeof params === 'object' && params !== null && 'request' in params
            ? String(params.request)
            : ''
        const state = ledger.has(request) ? 'completed' : 'absent'
        return reply({ requestId: request, state, interpretation: state })
      }
      if (method !== 'orchestration.send') {
        throw new Error(`unexpected ${method}`)
      }
      const requestId = options?.orchestrationRequestId ?? randomUUID()
      const timeout = 'Timed out waiting for the Orca runtime to respond.'
      // A replay's dial, or a held first dial, never connects: nothing is written.
      if (options?.orchestrationReplayOnly || fixture.nextSendUnsent) {
        fixture.nextSendUnsent = false
        throw attachMutationRecovery(
          new RuntimeClientError('runtime_timeout', timeout, { requestSent: false }),
          requestId,
          this.command,
          true
        )
      }
      // The send commits here and its reply is lost.
      sends.push({ ledger: this.ledgerKey, requestId })
      ledger.add(requestId)
      throw attachMutationRecovery(
        new RuntimeClientError('runtime_timeout', timeout),
        requestId,
        this.command
      )
    }
  }
  return { ...actual, RuntimeClient: LedgerClient }
})

vi.mock('../../hosts/execution-host-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof HostFlagModule>()),
  // Every name in these cases is a paired server already in the store.
  resolveEnvironmentSelectorForStore: async (selector: string) => selector
}))

import { main } from '../../index'

const PAIRING = 'orca://pair?secret-pairing-payload'
const PROFILE = '/tmp/orca-recovery-route-profile'
const SEND = [
  'orchestration',
  'send',
  '--from',
  'term_worker',
  '--subject',
  'done',
  '--type',
  'worker_done',
  '--task-id',
  'task_1',
  '--dispatch-id',
  'ctx_1',
  '--outcome',
  'succeeded',
  '--json'
]
const SELECTION_ENV = [
  'ORCA_PAIRING_CODE',
  'ORCA_REMOTE_PAIRING',
  'ORCA_ENVIRONMENT',
  'ORCA_USER_DATA_PATH'
]

type Recovery = {
  orchestrationRequestId: string
  queryCommand?: string[]
  retryCommand?: string[]
  requiredEnv?: string[]
  disposition: string
}

let output: string[] = []

// Each case runs the whole CLI, whose first import can take tens of seconds on a loaded host.
vi.setConfig({ testTimeout: 180_000 })

beforeEach(() => {
  ledgers.clear()
  sends.length = 0
  fixture.nextSendUnsent = false
  output = []
  vi.stubEnv('ORCA_CLI_COMMAND', 'orca')
  // Unset, not empty: an empty ORCA_PAIRING_CODE would hide ORCA_REMOTE_PAIRING.
  for (const name of SELECTION_ENV) {
    vi.stubEnv(name, undefined)
  }
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(' '))
  }
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
})

/** Runs one CLI invocation with `env` assigned for that invocation only, as `VAR=value orca ...` does. */
type Env = Record<string, string | undefined>

async function run(argv: string[], env: Env = {}): Promise<string> {
  const saved = new Map(SELECTION_ENV.map((name) => [name, process.env[name]]))
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value)
  }
  output = []
  try {
    await main(argv, '/tmp')
  } finally {
    for (const [name, value] of saved) {
      vi.stubEnv(name, value)
    }
  }
  return output.join('\n')
}

async function original(argv: string[], env: Env = {}) {
  const text = await run(argv, env)
  const json = text.split('\n').find((line) => line.startsWith('{')) ?? '{}'
  const parsed: { error?: { data?: { recovery?: Recovery } } } = JSON.parse(json)
  const recovery = parsed.error?.data?.recovery
  if (!recovery) {
    throw new Error(`expected recovery guidance, got ${text}`)
  }
  return { text, recovery }
}

/** What a request-show run reports once only the shell's lasting environment remains. */
async function inspect(argv: string[] | undefined, env: Env = {}) {
  expect(argv?.[0]).toBe('orca')
  const text = await run(argv?.slice(1) ?? [], env)
  return text.includes('"state":"completed"')
    ? 'completed'
    : text.includes('"state":"absent"')
      ? 'absent'
      : text
}

/** The Orca a keyed retry reaches through the real parser and route selection. */
async function retryLands(argv: string[] | undefined, env: Env = {}) {
  expect(argv?.[0]).toBe('orca')
  const before = sends.length
  const text = await run(argv?.slice(1) ?? [], env)
  return sends[before]?.ledger ?? text
}

const LOCAL = `profile:${getPlatformUserDataPath()}`
const STATUS = [
  'orchestration',
  'send',
  '--from',
  'term_worker',
  '--to',
  'term_coordinator',
  '--subject',
  'status',
  '--type',
  'status',
  '--json'
]
const bareQuery = (id: string) => [
  'orca',
  'orchestration',
  'request-show',
  '--request',
  id,
  '--json'
]
const keyedRetry = (argv: string[], id: string) => ['orca', ...argv, '--retry-request', id]

describe('recovery commands that select the original Orca by themselves', () => {
  it('names the environment ORCA_ENVIRONMENT chose in both inspect and retry', async () => {
    const { text, recovery } = await original(SEND, { ORCA_ENVIRONMENT: 'devbox' })
    const id = recovery.orchestrationRequestId

    expect(sends).toEqual([{ ledger: 'environment:devbox', requestId: id }])
    expect(recovery.queryCommand).toEqual([
      ...bareQuery(id).slice(0, -1),
      '--environment',
      'devbox',
      '--json'
    ])
    expect(recovery.retryCommand).toEqual([
      ...keyedRetry(SEND, id).slice(0, -2),
      '--environment',
      'devbox',
      '--retry-request',
      id
    ])
    expect(await inspect(recovery.queryCommand)).toBe('completed')
    expect(await retryLands(recovery.retryCommand)).toBe('environment:devbox')
    // A restored pairing export conflicts with the named target: it refuses, and the guidance says so.
    expect(text).toContain('ORCA_PAIRING_CODE and ORCA_REMOTE_PAIRING are unset or empty')
    expect(await inspect(recovery.queryCommand, { ORCA_PAIRING_CODE: PAIRING })).toContain(
      'Use either --pairing-code or --environment'
    )
  })

  it.each([
    ['from ORCA_ENVIRONMENT', SEND, { ORCA_ENVIRONMENT: '--odd' }],
    ['from an inline --environment', [...SEND, '--environment=--odd'], {}]
  ])('keeps an option-like environment name a value %s', async (_case, argv, env) => {
    const { recovery } = await original(argv, env)

    expect(recovery.queryCommand).toContain('--environment=--odd')
    expect(recovery.retryCommand).toContain('--environment=--odd')
    expect(await inspect(recovery.queryCommand)).toBe('completed')
    expect(await retryLands(recovery.retryCommand)).toBe('environment:--odd')
  })

  it.each([
    ['ORCA_ENVIRONMENT', { ORCA_ENVIRONMENT: 'devbox' }],
    ['a pairing code', { ORCA_PAIRING_CODE: PAIRING }]
  ])(
    'pins a local original to local when an empty one-shot hid an exported %s',
    async (_case, exported) => {
      for (const [name, value] of Object.entries(exported)) {
        vi.stubEnv(name, value)
      }
      const hidden = Object.fromEntries(Object.keys(exported).map((name) => [name, '']))
      const { recovery } = await original(SEND, hidden)

      expect(sends[0]?.ledger).toBe(LOCAL)
      expect(recovery.queryCommand).toContain('local')
      expect(recovery.retryCommand?.slice(-4)).toEqual([
        '--environment',
        'local',
        '--retry-request',
        recovery.orchestrationRequestId
      ])
      expect(await inspect(recovery.queryCommand)).toBe('completed')
      expect(await retryLands(recovery.retryCommand)).toBe(LOCAL)
    }
  )

  it('offers a fresh unsent send its keyed retry on the same local Orca', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'devbox')
    fixture.nextSendUnsent = true
    const { recovery } = await original(STATUS, { ORCA_ENVIRONMENT: '' })

    expect(sends).toEqual([])
    expect(recovery.disposition).toBe('not_sent')
    expect(await retryLands(recovery.retryCommand)).toBe(LOCAL)
  })

  it('keeps an explicit local route over an exported environment', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'devbox')
    const { recovery } = await original([...SEND, '--environment', 'local'])

    expect(recovery.queryCommand).toContain('local')
    expect(recovery.queryCommand).not.toContain('devbox')
    expect(recovery.retryCommand).not.toContain('devbox')
    expect(await inspect(recovery.queryCommand)).toBe('completed')
    expect(await retryLands(recovery.retryCommand)).toBe(LOCAL)
  })

  it('asks the caller’s own Orca for an outer --on send, whatever the shell selects', async () => {
    const { recovery } = await original([...SEND, '--on', 'devbox'], {
      ORCA_ENVIRONMENT: 'other',
      ORCA_PAIRING_CODE: PAIRING
    })

    expect(recovery.queryCommand).toEqual([
      ...bareQuery(recovery.orchestrationRequestId).slice(0, -1),
      '--environment',
      'local',
      '--json'
    ])
    vi.stubEnv('ORCA_ENVIRONMENT', 'other')
    expect(await inspect(recovery.queryCommand)).toBe('completed')
    expect(await retryLands(recovery.retryCommand)).toBe(LOCAL)
  })
})

describe('recovery commands withheld when only the original shell selects its Orca', () => {
  it('names ORCA_PAIRING_CODE and the conditions that select it again, never the code', async () => {
    const { text, recovery } = await original(SEND, { ORCA_PAIRING_CODE: PAIRING })
    const id = recovery.orchestrationRequestId

    expect(recovery).not.toHaveProperty('queryCommand')
    expect(recovery).not.toHaveProperty('retryCommand')
    expect(recovery).toMatchObject({
      disposition: 'outcome_unknown',
      requiredEnv: ['ORCA_PAIRING_CODE']
    })
    expect(text).toContain(
      'ORCA_PAIRING_CODE is set to the same pairing as for this command, and ORCA_ENVIRONMENT is unset or empty'
    )
    expect(text).toContain(bareQuery(id).join(' '))
    expect(text).not.toContain('secret-pairing-payload')
    // Following the recipe reaches the original's Orca.
    const restored = { ORCA_PAIRING_CODE: PAIRING }
    expect(await inspect(bareQuery(id), restored)).toBe('completed')
    expect(await retryLands(keyedRetry(SEND, id), restored)).toBe(`pairing:${PAIRING}`)
  })

  it('requires ORCA_PAIRING_CODE unset when the fallback ORCA_REMOTE_PAIRING chose the Orca', async () => {
    const { text, recovery } = await original(SEND, { ORCA_REMOTE_PAIRING: PAIRING })
    const id = recovery.orchestrationRequestId

    expect(recovery).not.toHaveProperty('queryCommand')
    expect(recovery.requiredEnv).toEqual(['ORCA_REMOTE_PAIRING', 'ORCA_PAIRING_CODE'])
    expect(text).toContain(
      'ORCA_REMOTE_PAIRING is set to the same pairing as for this command and ORCA_PAIRING_CODE is unset'
    )
    expect(await inspect(bareQuery(id), { ORCA_REMOTE_PAIRING: PAIRING })).toBe('completed')
    // An exported primary wins over the fallback, which is why the recipe names it.
    const other = 'orca://pair?other-pairing'
    expect(
      await inspect(bareQuery(id), { ORCA_REMOTE_PAIRING: PAIRING, ORCA_PAIRING_CODE: other })
    ).toBe('absent')
  })

  it('withholds commands for a saved server named local, which --environment local cannot reach', async () => {
    const { text, recovery } = await original(SEND, { ORCA_ENVIRONMENT: 'local' })
    const id = recovery.orchestrationRequestId

    expect(sends[0]?.ledger).toBe('environment:local')
    expect(recovery).not.toHaveProperty('queryCommand')
    expect(recovery).not.toHaveProperty('retryCommand')
    expect(text).toContain('ORCA_ENVIRONMENT names the same saved server as for this command')
    expect(await inspect(bareQuery(id), { ORCA_ENVIRONMENT: 'local' })).toBe('completed')
    expect(await inspect([...bareQuery(id).slice(0, -1), '--environment', 'local', '--json'])).toBe(
      'absent'
    )
  })

  it('gives a fresh unsent send the same recipe for its keyed rerun', async () => {
    fixture.nextSendUnsent = true
    const { text, recovery } = await original(STATUS, { ORCA_PAIRING_CODE: PAIRING })

    expect(recovery).toMatchObject({ disposition: 'not_sent', recoveryBlocked: true })
    expect(recovery).not.toHaveProperty('retryCommand')
    expect(text).toContain(
      `--retry-request ${recovery.orchestrationRequestId} from a shell where ORCA_PAIRING_CODE is set`
    )
    expect(
      await retryLands(keyedRetry(STATUS, recovery.orchestrationRequestId), {
        ORCA_PAIRING_CODE: PAIRING
      })
    ).toBe(`pairing:${PAIRING}`)
  })
})

describe('the profile, which only ORCA_USER_DATA_PATH selects', () => {
  it('states an alternate profile as a prerequisite, without printing its path', async () => {
    const { text, recovery } = await original(SEND, { ORCA_USER_DATA_PATH: PROFILE })

    expect(sends[0]?.ledger).toBe(`profile:${PROFILE}`)
    expect(recovery.requiredEnv).toEqual(['ORCA_USER_DATA_PATH'])
    expect(text).not.toContain(PROFILE)
    expect(await inspect(recovery.queryCommand)).toBe('absent')
    expect(await inspect(recovery.queryCommand, { ORCA_USER_DATA_PATH: PROFILE })).toBe('completed')
    expect(await retryLands(recovery.retryCommand, { ORCA_USER_DATA_PATH: PROFILE })).toBe(
      `profile:${PROFILE}`
    )
  })

  it.each([
    ['an empty', '', 'ran with ORCA_USER_DATA_PATH empty'],
    ['the default', getPlatformUserDataPath(), 'ORCA_USER_DATA_PATH names the same Orca profile']
  ])(
    'states %s one-shot override of an exported alternate profile',
    async (_case, override, condition) => {
      vi.stubEnv('ORCA_USER_DATA_PATH', PROFILE)
      const { text, recovery } = await original(SEND, { ORCA_USER_DATA_PATH: override })

      expect(sends[0]?.ledger).toBe(LOCAL)
      expect(recovery.requiredEnv).toEqual(['ORCA_USER_DATA_PATH'])
      expect(text).toContain(condition)
      expect(await inspect(recovery.queryCommand)).toBe('absent')
      expect(await inspect(recovery.queryCommand, { ORCA_USER_DATA_PATH: override })).toBe(
        'completed'
      )
      expect(await retryLands(recovery.retryCommand, { ORCA_USER_DATA_PATH: override })).toBe(LOCAL)
    }
  )
})
