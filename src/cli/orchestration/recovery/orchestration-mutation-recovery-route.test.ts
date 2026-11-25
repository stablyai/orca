import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_RUNTIME_CAPABILITIES } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { getPlatformUserDataPath } from '../../runtime/profile/metadata'
import type * as ClientModule from '../../runtime/client'
import type * as HostFlagModule from '../../hosts/execution-host-flag'

// Each Orca a command can reach keeps its own receipt ledger: the original lands in one of them,
// and the recovery commands it prints must ask that same one after a one-shot assignment expires.
const { ledgers } = vi.hoisted(() => ({ ledgers: new Map<string, Set<string>>() }))

vi.mock('../../runtime/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ClientModule>()
  const { RuntimeClientError } = await import('../../runtime/connection/types')
  const { attachMutationRecovery } = await import('../../runtime/connection/client-error-recovery')
  type Args = ConstructorParameters<typeof actual.RuntimeClient>
  /** The real client's route selection, with each reachable Orca played by an in-memory ledger. */
  class LedgerClient extends actual.RuntimeClient {
    private readonly ledgerKey: string
    private readonly command: string[]
    constructor(...args: Args) {
      super(...args)
      // The same defaults the real constructor applies to an omitted selection.
      const pairing =
        args[2] === undefined
          ? (process.env.ORCA_PAIRING_CODE ?? process.env.ORCA_REMOTE_PAIRING ?? null)
          : args[2]
      this.ledgerKey = pairing
        ? `pairing:${pairing}`
        : this.environmentSelector
          ? `environment:${this.environmentSelector}`
          : `profile:${this.userDataPath}`
      this.command = ['orca', ...(args[5] ?? [])]
    }

    override async call(
      method: string,
      params?: unknown,
      options?: { orchestrationRequestId?: string; orchestrationReplayOnly?: true }
    ): Promise<never> {
      const ledger = ledgers.get(this.ledgerKey) ?? new Set<string>()
      ledgers.set(this.ledgerKey, ledger)
      const id = 'rpc'
      const _meta = { runtimeId: this.ledgerKey }
      if (method === 'status.get') {
        return {
          id,
          ok: true,
          result: { capabilities: ORCHESTRATION_RUNTIME_CAPABILITIES },
          _meta
        } as never
      }
      if (method === 'orchestration.requestShow') {
        const request = (params as { request: string }).request
        const state = ledger.has(request) ? 'completed' : 'absent'
        return {
          id,
          ok: true,
          result: { requestId: request, state, interpretation: state },
          _meta
        } as never
      }
      if (method !== 'orchestration.send') {
        throw new Error(`unexpected ${method}`)
      }
      const requestId = options?.orchestrationRequestId ?? randomUUID()
      if (options?.orchestrationReplayOnly) {
        // The replay's dial never connects, so it adds nothing to the outcome.
        throw attachMutationRecovery(
          new RuntimeClientError(
            'runtime_timeout',
            'Timed out waiting for the Orca runtime to respond.',
            {
              requestSent: false
            }
          ),
          requestId,
          this.command,
          true
        )
      }
      // The original commits here and its reply is lost.
      ledger.add(requestId)
      throw attachMutationRecovery(
        new RuntimeClientError(
          'runtime_timeout',
          'Timed out waiting for the Orca runtime to respond.'
        ),
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
async function run(argv: string[], env: Record<string, string> = {}): Promise<string> {
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

async function original(argv: string[], env: Record<string, string> = {}) {
  const text = await run(argv, env)
  const json = text.split('\n').find((line) => line.startsWith('{')) ?? '{}'
  const parsed: { error?: { data?: { recovery?: Recovery } } } = JSON.parse(json)
  const recovery = parsed.error?.data?.recovery
  if (!recovery) {
    throw new Error(`expected recovery guidance, got ${text}`)
  }
  return { text, recovery }
}

/** What the printed inspect command reports once only the shell's lasting environment remains. */
async function inspect(recovery: Recovery, env: Record<string, string> = {}) {
  expect(recovery.queryCommand?.[0]).toBe('orca')
  const text = await run(recovery.queryCommand?.slice(1) ?? [], env)
  return text.includes('"state":"completed"')
    ? 'completed'
    : text.includes('"state":"absent"')
      ? 'absent'
      : text
}

describe('recovery commands after a selection that lasted only for the original command', () => {
  it('names the environment ORCA_ENVIRONMENT chose, so inspect and retry reach the same Orca', async () => {
    const { recovery } = await original(SEND, { ORCA_ENVIRONMENT: 'devbox' })

    expect(ledgers.get('environment:devbox')?.has(recovery.orchestrationRequestId)).toBe(true)
    expect(recovery.queryCommand).toEqual([
      'orca',
      'orchestration',
      'request-show',
      '--request',
      recovery.orchestrationRequestId,
      '--environment',
      'devbox',
      '--json'
    ])
    expect(recovery.retryCommand).toEqual([
      'orca',
      ...SEND,
      '--environment',
      'devbox',
      '--retry-request',
      recovery.orchestrationRequestId
    ])
    expect(await inspect(recovery)).toBe('completed')
  })

  it.each(['ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING'])(
    'withholds standalone commands when %s chose the Orca, naming the variable and never the code',
    async (name) => {
      const { text, recovery } = await original(SEND, { [name]: PAIRING })

      expect(ledgers.get(`pairing:${PAIRING}`)?.has(recovery.orchestrationRequestId)).toBe(true)
      expect(recovery).not.toHaveProperty('queryCommand')
      expect(recovery).not.toHaveProperty('retryCommand')
      expect(recovery).toMatchObject({ disposition: 'outcome_unknown', requiredEnv: [name] })
      expect(text).toContain(`with ${name} set to the same pairing this command used`)
      expect(text).toContain(`--retry-request ${recovery.orchestrationRequestId}`)
      expect(text).not.toContain('secret-pairing-payload')
      // The default ledger never saw it; the original pairing finds it.
      expect(ledgers.get(`profile:${getPlatformUserDataPath()}`)?.size ?? 0).toBe(0)
    }
  )

  it('states the profile ORCA_USER_DATA_PATH chose as a prerequisite, without printing its path', async () => {
    const { text, recovery } = await original(SEND, { ORCA_USER_DATA_PATH: PROFILE })

    expect(ledgers.get(`profile:${PROFILE}`)?.has(recovery.orchestrationRequestId)).toBe(true)
    expect(recovery.requiredEnv).toEqual(['ORCA_USER_DATA_PATH'])
    expect(text).toContain('ORCA_USER_DATA_PATH')
    expect(text).not.toContain(PROFILE)
    expect(await inspect(recovery)).toBe('absent')
    expect(await inspect(recovery, { ORCA_USER_DATA_PATH: PROFILE })).toBe('completed')
  })
})

describe('recovery commands whose selection still holds', () => {
  it('works with an exported environment, as before', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'devbox')
    const { recovery } = await original(SEND)

    expect(await inspect(recovery)).toBe('completed')
    expect(recovery).not.toHaveProperty('requiredEnv')
  })

  it('keeps a named --environment', async () => {
    const { recovery } = await original([...SEND, '--environment', 'devbox'])

    expect(recovery.retryCommand).toEqual([
      'orca',
      ...SEND,
      '--environment',
      'devbox',
      '--retry-request',
      recovery.orchestrationRequestId
    ])
    expect(await inspect(recovery)).toBe('completed')
  })

  it('keeps an explicit local route over an exported environment and pairing', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'devbox')
    const { recovery } = await original([...SEND, '--environment', 'local'])

    expect(recovery.queryCommand).toContain('local')
    expect(recovery.queryCommand).not.toContain('devbox')
    expect(recovery.retryCommand).not.toContain('devbox')
    expect(recovery).not.toHaveProperty('requiredEnv')
    expect(await inspect(recovery)).toBe('completed')
  })

  it('asks the caller’s own Orca for an outer --on send, whatever the shell selects', async () => {
    const { recovery } = await original([...SEND, '--on', 'devbox'], {
      ORCA_ENVIRONMENT: 'other',
      ORCA_PAIRING_CODE: PAIRING
    })

    expect(recovery.queryCommand).toEqual([
      'orca',
      'orchestration',
      'request-show',
      '--request',
      recovery.orchestrationRequestId,
      '--environment',
      'local',
      '--json'
    ])
    expect(recovery).not.toHaveProperty('requiredEnv')
    expect(await inspect(recovery, { ORCA_ENVIRONMENT: 'other' })).toBe('completed')
  })
})
