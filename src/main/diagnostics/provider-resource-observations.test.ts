import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, link, copyFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProviderResourceObservations } from './provider-resource-observations'

describe('execution-owned provider resource diagnostics', () => {
  let root: string
  let path: string
  let now: number
  let owner: ProviderResourceObservations

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'provider-resource-diagnostic-'))
    path = join(root, 'synthetic.jsonl')
    await writeFile(path, '{}\n')
    now = Date.now()
    owner = new ProviderResourceObservations(() => now)
  })

  afterEach(async () => {
    owner.dispose()
    await rm(root, { recursive: true, force: true })
  })

  function launch(token = 'synthetic-launch', incarnationId = 'generation-a') {
    owner.captureLaunch({
      ptyId: 'pty-a',
      incarnationId,
      env: {
        ORCA_PROVIDER_RESOURCE_DIAGNOSTICS: '1',
        ORCA_PANE_KEY: 'pane-a',
        ORCA_AGENT_LAUNCH_TOKEN: token,
        CLAUDE_CONFIG_DIR: root
      }
    })
  }

  async function hook(token = 'synthetic-launch') {
    await owner.observeHook({
      paneKey: 'pane-a',
      launchToken: token,
      hookEventName: 'SessionStart',
      providerSession: { id: 'synthetic-session', transcriptPath: path }
    })
  }

  function query(transcriptPath = path, sessionId = 'synthetic-session') {
    return owner.query(
      { requestId: 'request-a', agent: 'claude', transcriptPath, sessionId },
      () => 'live'
    )
  }

  async function observe() {
    launch()
    await hook()
    await expect.poll(async () => (await query()).facts?.objectObserved).toBe(true)
    return query()
  }

  it('joins allowlisted metadata without promoting hook correspondence to authority', async () => {
    const result = await observe()
    expect(result).toMatchObject({
      verdict: 'unverifiable',
      reason: 'missing-lifecycle-contract',
      facts: {
        rootResolved: true,
        reportedSessionMatches: true,
        launchTokenMatches: true,
        lifecycleBound: false,
        providerProcess: 'unverifiable',
        pty: { verdict: 'live' }
      }
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain('synthetic-launch')
    expect(serialized).not.toContain('synthetic-session')
  })

  it('resolves hardlinks by retained object and separates copies with the same reported session', async () => {
    const original = await observe()
    const alias = join(root, 'alias.jsonl')
    const copy = join(root, 'copy.jsonl')
    await link(path, alias)
    await copyFile(path, copy)
    expect((await query(alias)).observationId).toBe(original.observationId)
    expect((await query(copy)).reason).toBe('missing-retention')
    expect((await query(alias, 'different-session')).facts?.reportedSessionMatches).toBe(false)
  })

  it('does not let a delayed old hook overwrite a new PTY generation', async () => {
    await observe()
    launch('new-launch', 'generation-b')
    await hook('stale-launch')
    expect((await query()).facts?.pty.incarnationId).toBe('generation-a')
    await hook('new-launch')
    await expect.poll(async () => (await query()).reason).toBe('conflicting-candidates')
  })

  it('refuses a replaced pathname while preserving the retained object', async () => {
    await observe()
    const old = join(root, 'old.jsonl')
    await rename(path, old)
    await writeFile(path, '{}\n')
    expect((await query(old)).reason).toBe('path-replaced')
    expect((await query(path)).reason).toBe('missing-retention')
  })

  it('loses retention at the finite trial boundary and fences a different host epoch', async () => {
    await observe()
    expect(
      (
        await owner.query(
          { requestId: 'request-a', agent: 'claude', epoch: 'old', transcriptPath: path },
          () => 'live'
        )
      ).reason
    ).toBe('stale-epoch')
    now += 15 * 60_000
    expect((await query()).reason).toBe('missing-retention')
  })

  it('keeps resource authority unverifiable even when the host observed PTY exit', async () => {
    await observe()
    const result = await owner.query(
      { requestId: 'request-a', agent: 'claude', transcriptPath: path },
      () => 'exited'
    )
    expect(result.verdict).toBe('unverifiable')
    expect(result.facts?.pty.verdict).toBe('exited')
    expect(result.facts?.providerProcess).toBe('unverifiable')
  })

  it('does not inspect unsupported providers or relative/missing resource paths', async () => {
    expect(
      (
        await owner.query(
          { requestId: 'request-a', agent: 'codex', transcriptPath: path },
          () => 'live'
        )
      ).reason
    ).toBe('unsupported')
    expect((await query('relative.jsonl')).reason).toBe('missing-retention')
    expect((await query()).reason).toBe('missing-retention')
  })

  it('does not join a changed reported session to the previously retained transcript', async () => {
    await observe()
    await owner.observeHook({
      paneKey: 'pane-a',
      launchToken: 'synthetic-launch',
      hookEventName: 'SessionStart',
      providerSession: { id: 'next-session' }
    })
    expect((await query()).reason).toBe('missing-retention')
  })

  it('evicts bounded retention without interpreting missing records as exit', async () => {
    await observe()
    for (let index = 0; index < 128; index++) {
      owner.captureLaunch({
        ptyId: `pty-${index}`,
        incarnationId: `generation-${index}`,
        env: {
          ORCA_PROVIDER_RESOURCE_DIAGNOSTICS: '1',
          ORCA_PANE_KEY: `pane-${index}`,
          ORCA_AGENT_LAUNCH_TOKEN: `synthetic-${index}`
        }
      })
    }
    await expect.poll(async () => (await query()).reason).toBe('missing-retention')
    expect((await query()).verdict).toBe('unverifiable')
  })
})
