import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApiKeySummary } from '../../shared/agent-api-keys/agent-api-key-catalog'
import type { CloudSecretView } from '../../shared/cloud-secrets/cloud-secrets-wire'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { AgentApiKeyCloudSync, type AgentApiKeyCloudConnection } from './agent-api-key-cloud-sync'

const VALUE = 'sk-ant-api03-cloud-sync-secret-9fQ2'
let root: string

function key(overrides: Partial<AgentApiKeySummary> = {}): AgentApiKeySummary {
  return {
    id: 'k1',
    agent: 'claude',
    envName: 'ANTHROPIC_API_KEY',
    hostScope: { kind: 'all' },
    hint: '9fQ2',
    updatedAt: 1,
    ...overrides
  }
}

function setup(accountId: string | null = 'user-a', vault: AgentApiKeySummary[] = []) {
  const view: CloudSecretView = {
    scope: 'personal',
    name: 'ANTHROPIC_API_KEY',
    kind: 'agent_key',
    hint: '9fQ2',
    updatedAt: 1,
    updatedBy: 'user-a'
  }
  const client = {
    put: vi.fn(async () => view),
    remove: vi.fn(async (_target: { scope: 'personal' }, _name: string) => {})
  }
  let generation = 0
  const connect = (id: string): AgentApiKeyCloudConnection => {
    const at = generation
    return { accountId: id, client, isCurrent: () => generation === at }
  }
  let current: AgentApiKeyCloudConnection | null = accountId ? connect(accountId) : null
  let offline = false
  const sync = new AgentApiKeyCloudSync({
    ledgerPath: join(root, 'ledger.json'),
    link: async () =>
      !current
        ? { kind: 'signed-out' }
        : offline
          ? { kind: 'unreachable', accountId: current.accountId }
          : { kind: 'connected', connection: current },
    valueOf: async () => VALUE,
    listKeys: async () => vault,
    now: () => 100
  })
  return {
    client,
    sync,
    signInAs: (id: string | null) => {
      generation++
      current = id ? connect(id) : null
    },
    setOffline: (next: boolean) => {
      offline = next
    }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-key-cloud-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('AgentApiKeyCloudSync', () => {
  it('writes a saved key to the personal secret of the same name and records only its name', async () => {
    const { client, sync } = setup()
    expect(await sync.push(key())).toEqual({ kind: 'synced' })
    expect(client.put).toHaveBeenCalledWith({ scope: 'personal' }, 'ANTHROPIC_API_KEY', VALUE)
    const ledger = await readFile(join(root, 'ledger.json'), 'utf8')
    expect(ledger).not.toContain(VALUE)
    expect(ledger).not.toContain('9fQ2')
    expect(await sync.state([key()])).toEqual({ signedIn: true, synced: ['k1'], managed: ['k1'] })
  })

  it('stays local-only when signed out', async () => {
    const { client, sync } = setup(null)
    expect(await sync.push(key())).toEqual({ kind: 'skipped' })
    expect(client.put).not.toHaveBeenCalled()
    expect(await sync.state([key()])).toEqual({ signedIn: false, synced: [], managed: [] })
  })

  it('skips host-scoped keys and refuses names the proxy cannot swap', async () => {
    const { client, sync } = setup()
    expect(await sync.push(key({ hostScope: { kind: 'hosts', hostIds: ['local'] } }))).toEqual({
      kind: 'skipped'
    })
    expect(await sync.push(key({ envName: 'AWS_BEARER_TOKEN_BEDROCK' }))).toEqual({
      kind: 'failed',
      error: 'not_swappable',
      keyId: 'k1'
    })
    expect(client.put).not.toHaveBeenCalled()
  })

  it('reports a failed write as a code, never the value, and logs only the code', async () => {
    const { client, sync } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    client.put.mockRejectedValueOnce(
      new EnvironmentProviderError('unavailable', `upstream echoed ${VALUE}`)
    )
    const outcome = await sync.push(key())
    expect(outcome).toEqual({ kind: 'failed', error: 'unavailable', keyId: 'k1' })
    expect(JSON.stringify(outcome)).not.toContain(VALUE)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(VALUE)
    expect(await sync.state([key()])).toEqual({
      signedIn: true,
      synced: [],
      managed: [],
      pending: ['k1']
    })
    warn.mockRestore()
  })

  it('treats an edited key whose write failed as not synced, but still managed', async () => {
    const { client, sync } = setup()
    await sync.push(key())
    client.put.mockRejectedValueOnce(new EnvironmentProviderError('timeout', 'slow'))
    const edited = key({ updatedAt: 2, hint: 'zzzz' })
    await sync.push(edited)
    expect(await sync.state([edited])).toEqual({
      signedIn: true,
      synced: [],
      managed: ['k1'],
      pending: ['k1']
    })
  })

  it('keeps one ledger per Orca account', async () => {
    const { sync, signInAs } = setup()
    await sync.push(key())
    signInAs('user-b')
    expect(await sync.state([key()])).toEqual({ signedIn: true, synced: [], managed: [] })
  })

  it('removes the account copy only for a key this computer wrote, and only when asked', async () => {
    const { client, sync } = setup()
    await sync.push(key())
    // Another vault key with the same variable never wrote it: refused, nothing removed.
    expect(await sync.beforeRemove(key({ id: 'other' }), true)).toEqual({
      ok: false,
      error: 'not_found'
    })
    expect(client.remove).not.toHaveBeenCalled()
    const removal = await sync.beforeRemove(key(), true)
    expect(removal).toMatchObject({ ok: true, removedFromAccount: true })
    expect(client.remove).toHaveBeenCalledWith({ scope: 'personal' }, 'ANTHROPIC_API_KEY')
    // The ledger forgets only once the vault has removed the key.
    expect(await sync.state([key()])).toMatchObject({ managed: ['k1'] })
    if (removal.ok) {
      await removal.forget()
    }
    expect(await sync.state([key()])).toEqual({ signedIn: true, synced: [], managed: [] })
  })

  it('leaves the account copy when the user keeps it, and stops managing it', async () => {
    const { client, sync } = setup()
    await sync.push(key())
    const removal = await sync.beforeRemove(key(), false)
    expect(removal).toMatchObject({ ok: true, removedFromAccount: false })
    expect(client.remove).not.toHaveBeenCalled()
    if (removal.ok) {
      await removal.forget()
    }
    expect(await sync.state([key()])).toEqual({ signedIn: true, synced: [], managed: [] })
  })

  it('never removes a secret it has no ledger entry for (e.g. one created on the web)', async () => {
    const { client, sync } = setup()
    expect(await sync.beforeRemove(key(), true)).toEqual({ ok: false, error: 'not_found' })
    expect(client.remove).not.toHaveBeenCalled()
  })

  it('aborts the removal when the account delete fails, but treats not_found as done', async () => {
    const { client, sync } = setup()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sync.push(key())
    client.remove.mockRejectedValueOnce(new EnvironmentProviderError('unavailable', 'down'))
    expect(await sync.beforeRemove(key(), true)).toEqual({ ok: false, error: 'unavailable' })
    expect(await sync.state([key()])).toMatchObject({ managed: ['k1'] })
    client.remove.mockRejectedValueOnce(new EnvironmentProviderError('not_found', 'gone'))
    expect(await sync.beforeRemove(key(), true)).toMatchObject({
      ok: true,
      removedFromAccount: true
    })
    vi.mocked(console.warn).mockRestore()
  })

  it('refuses an account delete while signed out', async () => {
    const { sync } = setup(null)
    expect(await sync.beforeRemove(key(), true)).toEqual({ ok: false, error: 'unauthorized' })
    expect(await sync.beforeRemove(key(), false)).toMatchObject({
      ok: true,
      removedFromAccount: false
    })
  })

  it('does not overwrite another saved key’s account copy unless asked to replace it', async () => {
    const codex = key({ id: 'codex', agent: 'codex', envName: 'OPENAI_API_KEY' })
    const opencode = key({ id: 'opencode', agent: 'opencode', envName: 'OPENAI_API_KEY' })
    const { client, sync } = setup('user-a', [codex, opencode])
    await sync.push(codex)
    expect(await sync.push(opencode)).toEqual({
      kind: 'failed',
      error: 'desktop_key_conflict',
      keyId: 'opencode'
    })
    expect(client.put).toHaveBeenCalledTimes(1)
    expect(await sync.push(opencode, { replace: true })).toEqual({ kind: 'synced' })
    expect(await sync.state([codex, opencode])).toEqual({
      signedIn: true,
      synced: ['opencode'],
      managed: ['opencode']
    })
  })

  it('keeps tracking an account copy after a rename or narrower scope, and removes every copy', async () => {
    const { client, sync } = setup()
    await sync.push(key())
    const renamed = key({ envName: 'OPENAI_API_KEY', updatedAt: 2 })
    await sync.push(renamed)
    const scoped = key({
      envName: 'OPENAI_API_KEY',
      hostScope: { kind: 'hosts', hostIds: ['local'] },
      updatedAt: 3
    })
    expect(await sync.push(scoped)).toEqual({ kind: 'skipped' })
    expect(await sync.state([scoped])).toEqual({ signedIn: true, synced: [], managed: ['k1'] })
    expect(await sync.beforeRemove(scoped, true)).toMatchObject({ ok: true })
    expect(client.remove.mock.calls.map(([, name]) => name).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY'
    ])
  })

  it('does not claim a write that raced an account switch', async () => {
    const { client, sync, signInAs } = setup()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    client.put.mockImplementationOnce(async () => {
      signInAs('user-b')
      return {
        scope: 'personal',
        name: 'ANTHROPIC_API_KEY',
        kind: 'agent_key',
        hint: null,
        updatedAt: 1,
        updatedBy: 'user-b'
      }
    })
    expect(await sync.push(key())).toEqual({ kind: 'failed', error: 'unauthorized', keyId: 'k1' })
    signInAs('user-a')
    expect(await sync.state([key()])).toEqual({ signedIn: true, synced: [], managed: [] })
    vi.mocked(console.warn).mockRestore()
  })

  it('records a write made by the cloud workspace setup', async () => {
    const { sync } = setup()
    await sync.record(key())
    expect(await sync.state([key()])).toEqual({ signedIn: true, synced: ['k1'], managed: ['k1'] })
    await sync.record(key({ id: 'b', envName: 'AWS_BEARER_TOKEN_BEDROCK' }))
    expect(await sync.state([key({ id: 'b', envName: 'AWS_BEARER_TOKEN_BEDROCK' })])).toMatchObject(
      {
        managed: []
      }
    )
  })

  it('shows the last-known state while Orca is unreachable, and nothing for an account never connected here', async () => {
    const { sync, setOffline } = setup()
    setOffline(true)
    expect(await sync.state([key()])).toEqual({ signedIn: false, synced: [], managed: [] })
    setOffline(false)
    await sync.push(key())
    setOffline(true)
    expect(await sync.state([key()])).toEqual({
      signedIn: true,
      unreachable: true,
      synced: ['k1'],
      managed: ['k1']
    })
    const ledger = await readFile(join(root, 'ledger.json'), 'utf8')
    expect(ledger).not.toContain(VALUE)
  })

  it('queues a save made while offline and sends it when Orca is back, once', async () => {
    const edited = key({ updatedAt: 2 })
    const { client, sync, setOffline } = setup('user-a', [edited])
    await sync.push(key())
    setOffline(true)
    expect(await sync.push(edited)).toEqual({ kind: 'failed', error: 'unavailable', keyId: 'k1' })
    expect(await sync.state([edited])).toMatchObject({ unreachable: true, pending: ['k1'] })
    expect(sync.hasPending()).toBe(true)
    expect(await sync.flushPending()).toBe(false)
    setOffline(false)
    expect(await sync.flushPending()).toBe(true)
    expect(client.put).toHaveBeenCalledTimes(2)
    expect(await sync.state([edited])).toEqual({ signedIn: true, synced: ['k1'], managed: ['k1'] })
    expect(await sync.flushPending()).toBe(false)
    expect(client.put).toHaveBeenCalledTimes(2)
  })

  it('retries a failed request, but drops keys edited or removed since and non-transient failures', async () => {
    const other = key({ id: 'k2', envName: 'OPENAI_API_KEY' })
    const vault = [key(), other]
    const { client, sync } = setup('user-a', vault)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    client.put.mockRejectedValueOnce(new EnvironmentProviderError('timeout', 'slow'))
    client.put.mockRejectedValueOnce(new EnvironmentProviderError('timeout', 'slow'))
    await sync.push(key())
    await sync.push(other)
    expect(await sync.state(vault)).toMatchObject({ pending: ['k1', 'k2'] })
    // k1 was edited since its failed save: the user's newer save decides, not the retry.
    vault[0] = key({ updatedAt: 9 })
    expect(await sync.flushPending()).toBe(true)
    expect(client.put).toHaveBeenCalledTimes(3)
    expect(client.put).toHaveBeenLastCalledWith({ scope: 'personal' }, 'OPENAI_API_KEY', VALUE)
    expect(sync.hasPending()).toBe(false)
    vi.mocked(console.warn).mockRestore()
  })

  it('never queues keys saved while signed out', async () => {
    const { client, sync, signInAs } = setup(null, [key()])
    await sync.push(key())
    signInAs('user-a')
    expect(await sync.flushPending()).toBe(false)
    expect(client.put).not.toHaveBeenCalled()
  })
})
