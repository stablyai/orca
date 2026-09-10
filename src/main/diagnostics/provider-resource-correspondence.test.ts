import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProviderResourceObservations } from './provider-resource-observations'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>())
}))

describe('atomic hook and transcript correspondence', () => {
  let root: string
  let a: string
  let b: string
  let owner: ProviderResourceObservations
  const env = {
    ORCA_PROVIDER_RESOURCE_DIAGNOSTICS: '1',
    ORCA_PANE_KEY: 'pane',
    ORCA_AGENT_LAUNCH_TOKEN: 'synthetic'
  }
  const hook = (transcriptPath?: string, id = 'session') =>
    owner.observeHook({
      paneKey: 'pane',
      launchToken: 'synthetic',
      hookEventName: 'SessionStart',
      providerSession: { id, transcriptPath }
    })
  const query = (transcriptPath = a, sessionId = 'session') =>
    owner.query({
      requestId: 'test',
      agent: 'claude',
      transcriptPath,
      sessionId
    })
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'resource-correspondence-'))
    a = join(root, 'a.jsonl')
    b = join(root, 'b.jsonl')
    await fs.writeFile(a, '{}\n')
    await fs.writeFile(b, '{}\n')
    owner = new ProviderResourceObservations()
    owner.captureLaunch({ ptyId: 'pty', incarnationId: 'incarnation', env })
    await hook(a)
    await expect.poll(async () => (await query()).facts?.objectObserved).toBe(true)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    owner.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('moves a same-session correspondence to a distinct object', async () => {
    const before = await query()
    await hook(b)
    expect(await query()).toMatchObject({ verdict: 'unverifiable', reason: 'missing-retention' })
    expect((await query()).facts).toBeUndefined()
    const next = await query(b)
    expect(next.observationId).not.toBe(before.observationId)
    expect(next.facts?.hookSequence).toBeGreaterThan(before.facts!.hookSequence)
    expect(next.facts?.sessionCorrelationId).toBe(before.facts!.sessionCorrelationId)
    expect(next.facts?.reportedSessionMatches).toBe(true)
    expect(next.verdict).toBe('unverifiable')
  })

  it.each(['missing', 'omitted', 'null', 'relative', 'directory', 'extension'])(
    'invalidates on %s reads and can resume',
    async (kind) => {
      const directory = join(root, 'directory.jsonl')
      await fs.mkdir(directory)
      const paths = {
        missing: join(root, 'missing.jsonl'),
        omitted: undefined,
        null: null as unknown as string,
        relative: 'relative.jsonl',
        directory,
        extension: root
      }
      await hook(paths[kind as keyof typeof paths])
      expect((await query()).facts).toBeUndefined()
      expect((await query()).verdict).toBe('unverifiable')
      await hook(a)
      expect((await query()).facts?.reportedSessionMatches).toBe(true)
    }
  )

  it('accepts replacement only after its own hook and releases the previous descriptor', async () => {
    const opened = vi.spyOn(fs, 'open')
    await hook(a)
    const handle = await opened.mock.results[0].value
    const before = await query()
    const moved = join(root, 'moved.jsonl')
    await fs.rename(a, moved)
    await fs.writeFile(a, '{}\n')
    expect((await query(moved)).reason).toBe('path-replaced')
    expect((await query()).facts).toBeUndefined()
    await hook(a)
    expect((await query()).observationId).not.toBe(before.observationId)
    expect((await query(moved)).facts).toBeUndefined()
    await expect(handle.stat()).rejects.toThrow()
  })

  it('keeps the same object ID across a valid alias and rotates session correlation on resume', async () => {
    const before = await query()
    const alias = join(root, 'alias.jsonl')
    await fs.link(a, alias)
    await hook(alias)
    expect((await query()).observationId).toBe(before.observationId)
    expect((await query()).facts!.hookSequence).toBeGreaterThan(before.facts!.hookSequence)
    await hook(alias, 'resumed-session')
    const resumed = await query(alias, 'resumed-session')
    expect(resumed.observationId).toBe(before.observationId)
    expect(resumed.facts!.sessionCorrelationId).not.toBe(before.facts!.sessionCorrelationId)
    expect(resumed.facts!.reportedSessionMatches).toBe(true)
    expect((await query()).facts!.reportedSessionMatches).toBe(false)
  })

  it('does not publish an in-flight read superseded by a failed hook', async () => {
    const open = fs.open
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await gate
      return open(...args)
    })
    const pending = hook(b)
    expect((await query()).facts).toBeUndefined()
    await hook(join(root, 'missing.jsonl'))
    release()
    await pending
    await expect.poll(async () => (await query(b)).reason).toBe('missing-retention')
    expect((await query()).facts).toBeUndefined()
    await hook(a)
    await expect.poll(async () => (await query()).facts?.objectObserved).toBe(true)
  })

  it('fences an in-flight query when a newer hook invalidates its snapshot', async () => {
    const stat = fs.stat
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const spy = vi.spyOn(fs, 'stat')
    spy.mockImplementationOnce(stat).mockImplementationOnce(async (...args) => {
      await gate
      return stat(...args)
    })
    const pending = query()
    await expect.poll(() => spy.mock.calls.length).toBe(2)
    await hook(b)
    release()
    expect((await pending).facts).toBeUndefined()
    await expect.poll(async () => (await query(b)).facts?.objectObserved).toBe(true)
    expect((await query()).facts).toBeUndefined()
  })

  it('does not retain without opt-in and releases current descriptors on disposal', async () => {
    const opened = vi.spyOn(fs, 'open')
    await hook(b)
    const handle = await opened.mock.results[0].value
    owner.dispose()
    await expect(handle.stat()).rejects.toThrow()
    owner.captureLaunch({
      ptyId: 'off',
      incarnationId: 'off',
      env: { ...env, ORCA_PROVIDER_RESOURCE_DIAGNOSTICS: '0' }
    })
    await hook(a)
    expect((await query()).facts).toBeUndefined()
    expect((await query()).verdict).toBe('unverifiable')
  })
  it('bounds concurrent queries and invalidates even when no probe slot is available', async () => {
    const stat = fs.stat
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      await gate
      return stat(...args)
    })
    const pending = Array.from({ length: 8 }, () => query())
    expect((await query()).reason).toBe('probe-capacity')
    await hook(b)
    release()
    expect((await Promise.all(pending)).every((result) => !result.facts)).toBe(true)
    expect((await query()).facts).toBeUndefined()
    expect((await query(b)).facts).toBeUndefined()
    await hook(b)
    expect((await query(b)).facts?.objectObserved).toBe(true)
  })

  it('expires descriptors and rejects new enrollment after the owner trial', async () => {
    owner.dispose()
    let now = Date.now()
    owner = new ProviderResourceObservations(() => now)
    const opened = vi.spyOn(fs, 'open')
    owner.captureLaunch({ ptyId: 'pty', incarnationId: 'incarnation', env })
    await hook(a)
    await expect.poll(async () => (await query()).facts?.objectObserved).toBe(true)
    const handle = await opened.mock.results[0].value
    now += 15 * 60_000
    expect((await query()).facts).toBeUndefined()
    await expect(handle.stat()).rejects.toThrow()
    owner.captureLaunch({ ptyId: 'later', incarnationId: 'later', env })
    await hook(b)
    expect((await query(b)).facts).toBeUndefined()
  })
  it('releases a queued replacement descriptor when expiry occurs during a query', async () => {
    owner.dispose()
    let now = Date.now()
    owner = new ProviderResourceObservations(() => now)
    const opened = vi.spyOn(fs, 'open')
    owner.captureLaunch({ ptyId: 'pty', incarnationId: 'incarnation', env })
    await hook(a)
    await expect.poll(async () => (await query()).facts?.objectObserved).toBe(true)
    const handle = await opened.mock.results[0].value
    const stat = fs.stat
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const spy = vi.spyOn(fs, 'stat')
    spy.mockImplementationOnce(stat).mockImplementationOnce(async (...args) => {
      await gate
      return stat(...args)
    })
    const pending = query()
    await expect.poll(() => spy.mock.calls.length).toBe(2)
    await hook(b)
    now += 15 * 60_000
    release()
    expect((await pending).facts).toBeUndefined()
    await expect(handle.stat()).rejects.toThrow()
  })
})
