import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedRuntimeInstallation } from './managed-runtime-installation'
import {
  resolveInstalledRuntimeRelease,
  runtimeReleaseId,
  writeRuntimeReleaseReceipt,
  type ManagedRuntime,
  type ManagedRuntimePin
} from './managed-runtime-release'

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

function serverPin(version: string): { pin: ManagedRuntimePin; bytes: Buffer } {
  const bytes = Buffer.from(`#!/bin/sh\n# server ${version}\n`)
  return {
    bytes,
    pin: {
      version,
      url: `https://downloads.invalid/server-${version}`,
      archiveSha256: sha256(bytes),
      archiveBytes: bytes.length,
      format: 'file',
      members: [{ path: 'server', sha256: sha256(bytes), bytes: bytes.length }]
    }
  }
}

const PINNED = serverPin('1.5.2')
const OLD = serverPin('1.5.0')

let data: string
let root: string

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), 'orca-runtime-autoupdate-'))
  root = join(data, 'agent-runtimes', 'server')
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(data, { recursive: true, force: true })
})

/** An Orca-published release, as an earlier build's Install left it. */
async function seedRelease({ pin, bytes }: { pin: ManagedRuntimePin; bytes: Buffer }) {
  const folder = join(root, pin.version)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'server'), bytes)
  await chmod(join(folder, 'server'), 0o755)
  await writeRuntimeReleaseReceipt(folder, pin)
}

function runtime(overrides: Partial<ManagedRuntime> = {}): ManagedRuntime {
  return {
    label: 'Server',
    root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'server'),
    pin: () => PINNED.pin,
    updatesToPin: true,
    ...overrides
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

function serve(bytes: Buffer = PINNED.bytes) {
  return vi.fn<Fetch>(async () => new Response(new Uint8Array(bytes)))
}

/** A download refused in a way that may pass (not a checksum mismatch), without network retries. */
function refuse() {
  return vi.fn<Fetch>(async () => new Response('denied', { status: 403 }))
}

function installation(
  fetcher: Fetch,
  options: {
    runtime?: ManagedRuntime
    updatesEnabled?: () => boolean
    external?: boolean
  } = {}
) {
  return new ManagedRuntimeInstallation('server-agent', options.runtime ?? runtime(), {
    dataDirectory: data,
    program: 'server',
    findExternal: async () => options.external === true,
    fence: (work) => work(),
    fetcher,
    ...(options.updatesEnabled ? { updatesEnabled: options.updatesEnabled } : {})
  })
}

async function settled(subject: ManagedRuntimeInstallation) {
  await vi.waitFor(async () => {
    const phase = (await subject.status(false)).operation?.phase
    expect(['succeeded', 'failed', 'cancelled']).toContain(phase)
  })
  return subject.status(false)
}

const launches = () => resolveInstalledRuntimeRelease(root, PINNED.pin).release

const recordFile = () => join(data, 'agent-runtimes', '.server-auto-update.json')

async function writeRecord(fields: { attempts: number; lastAt: number }) {
  await mkdir(join(data, 'agent-runtimes'), { recursive: true })
  await writeFile(
    recordFile(),
    JSON.stringify({ releaseId: runtimeReleaseId(PINNED.pin), declined: false, ...fields })
  )
}

/** A download the test lets through, or fails, when it chooses. */
function heldServe() {
  const gate = Promise.withResolvers<void>()
  const fetcher = vi.fn<Fetch>(async (_url, init) => {
    await gate.promise
    init?.signal?.throwIfAborted()
    return new Response(new Uint8Array(PINNED.bytes))
  })
  return { fetcher, release: () => gate.resolve() }
}

async function runningId(subject: ManagedRuntimeInstallation): Promise<string> {
  const { operation } = await subject.status(false)
  expect(operation?.phase).toBe('downloading')
  return operation?.id ?? ''
}

it('updates an older Orca install to the pinned release without a click', async () => {
  await seedRelease(OLD)
  const fetcher = serve()
  const subject = installation(fetcher)
  await subject.updateIfBehind()
  const state = await settled(subject)
  expect(state.operation?.phase).toBe('succeeded')
  expect(state).toMatchObject({ installedVersion: '1.5.2', installedCurrent: true })
  expect(launches()).toMatchObject({ version: '1.5.2', current: true })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps the release running chats use until Orca next starts', async () => {
  await seedRelease(OLD)
  const subject = installation(serve())
  await subject.updateIfBehind()
  await settled(subject)
  // A chat started before the update still runs 1.5.0 from its folder.
  expect(await readFile(join(root, '1.5.0', 'server'))).toEqual(OLD.bytes)
  // The next start reclaims it, since launches now resolve to 1.5.2.
  installation(serve())
  await vi.waitFor(() => expect(existsSync(join(root, '1.5.0'))).toBe(false))
  expect(await readdir(root)).toEqual(['1.5.2'])
})

it('leaves sign-in files beside the releases untouched', async () => {
  await seedRelease(OLD)
  const tokens = join(data, 'antigravity-chat', 'antigravity-acp')
  await mkdir(tokens, { recursive: true })
  const files = ['oauth_token.json', 'google_accounts.json']
  for (const name of files) {
    await writeFile(join(tokens, name), `{"token":"${name}"}`)
  }
  const read = () =>
    Promise.all(
      files.map(async (name) => {
        const path = join(tokens, name)
        return { hash: sha256(await readFile(path)), mtime: (await stat(path)).mtimeMs }
      })
    )
  const before = await read()
  const subject = installation(serve())
  await subject.updateIfBehind()
  expect((await settled(subject)).operation?.phase).toBe('succeeded')
  expect(await read()).toEqual(before)
})

it('does not update again once the pinned release is installed', async () => {
  await seedRelease(OLD)
  const fetcher = serve()
  const subject = installation(fetcher)
  await subject.updateIfBehind()
  await settled(subject)
  await subject.updateIfBehind()
  await installation(fetcher).updateIfBehind()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps the older release on failure and backs off before retrying', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await seedRelease(OLD)
  const fetcher = refuse()
  const subject = installation(fetcher)
  await subject.updateIfBehind()
  const failed = await settled(subject)
  expect(failed.operation).toMatchObject({ phase: 'failed' })
  // It names the copy still in use, so the failure doesn't read as a broken install.
  expect(failed.operation?.error).toMatch(
    /^Couldn't update to 1\.5\.2, so 1\.5\.0 is still in use\./
  )
  expect(failed.operation?.error).toMatch(/Couldn't download Server/)
  // Settings still offers Update on the copy chats keep running.
  expect(failed).toMatchObject({ installedVersion: '1.5.0', installedCurrent: false })
  expect(launches()).toMatchObject({ version: '1.5.0', current: false })
  expect(await readdir(root)).toEqual(['1.5.0'])

  await subject.updateIfBehind()
  vi.setSystemTime(Date.now() + 59 * 60_000)
  await subject.updateIfBehind()
  expect(fetcher).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 2 * 60_000)
  await subject.updateIfBehind()
  await settled(subject)
  expect(fetcher).toHaveBeenCalledTimes(2)
  // The second failure waits two hours.
  vi.setSystemTime(Date.now() + 90 * 60_000)
  await subject.updateIfBehind()
  expect(fetcher).toHaveBeenCalledTimes(2)
  vi.setSystemTime(Date.now() + 31 * 60_000)
  await subject.updateIfBehind()
  await settled(subject)
  expect(fetcher).toHaveBeenCalledTimes(3)
  // Three automatic attempts are all; Update stays offered.
  vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60_000)
  await subject.updateIfBehind()
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect((await subject.status()).updatesAutomatically).toBeUndefined()
})

it('honors the kill switch', async () => {
  await seedRelease(OLD)
  const fetcher = serve()
  await installation(fetcher, { updatesEnabled: () => false }).updateIfBehind()
  expect(fetcher).not.toHaveBeenCalled()
  expect(launches()).toMatchObject({ version: '1.5.0' })
})

it('installs nothing where Orca has no release', async () => {
  const fetcher = serve()
  await installation(fetcher).updateIfBehind()
  expect(fetcher).not.toHaveBeenCalled()
  expect(existsSync(root)).toBe(false)
})

it('never downgrades a newer release', async () => {
  await seedRelease(serverPin('1.6.0'))
  const fetcher = serve()
  await installation(fetcher).updateIfBehind()
  expect(fetcher).not.toHaveBeenCalled()
})

it('leaves runtimes that do not follow their pin to Update', async () => {
  await seedRelease(OLD)
  const fetcher = serve()
  await installation(fetcher, { runtime: runtime({ updatesToPin: undefined }) }).updateIfBehind()
  expect(fetcher).not.toHaveBeenCalled()
})

it('treats a Cancel of an automatic update as declining that release', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await seedRelease(OLD)
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  const fetcher = vi.fn<Fetch>(async (_url, init) => {
    await held
    init?.signal?.throwIfAborted()
    return new Response(new Uint8Array(PINNED.bytes))
  })
  const subject = installation(fetcher)
  await subject.updateIfBehind()
  const running = await subject.status(false)
  const cancelled = subject.cancel(running.operation?.id ?? '')
  release()
  expect((await cancelled)?.phase).toBe('cancelled')
  vi.setSystemTime(Date.now() + 48 * 60 * 60_000)
  await subject.updateIfBehind()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(launches()).toMatchObject({ version: '1.5.0' })
})

it('keeps its backoff across host restarts, so a failing update is not fetched on every start', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await seedRelease(OLD)
  const fetcher = refuse()
  const first = installation(fetcher)
  await first.updateIfBehind()
  expect((await settled(first)).operation?.phase).toBe('failed')
  // orcad idle-exits and a client reconnects: each start is a new installation.
  for (let start = 0; start < 3; start += 1) {
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await installation(fetcher).updateIfBehind()
  }
  expect(fetcher).toHaveBeenCalledTimes(1)
  // Once the wait has passed, a later start tries again.
  vi.setSystemTime(Date.now() + 31 * 60_000)
  const later = installation(fetcher)
  await later.updateIfBehind()
  await settled(later)
  expect(fetcher).toHaveBeenCalledTimes(2)
  // The record sits beside the release root, where launch reclaim never deletes it.
  expect(await readdir(join(data, 'agent-runtimes'))).toContain('.server-auto-update.json')
  installation(fetcher)
  await vi.waitFor(async () => expect(await readdir(root)).toEqual(['1.5.0']))
  expect(await readdir(join(data, 'agent-runtimes'))).toContain('.server-auto-update.json')
})

it('remembers a Cancel across restarts until Orca pins another release', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await seedRelease(OLD)
  const held = heldServe()
  const subject = installation(held.fetcher)
  await subject.updateIfBehind()
  const cancelled = subject.cancel(await runningId(subject))
  held.release()
  expect((await cancelled)?.phase).toBe('cancelled')
  vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000)
  await installation(held.fetcher).updateIfBehind()
  expect(held.fetcher).toHaveBeenCalledTimes(1)
  const next = serverPin('1.5.3')
  const fetcher = serve(next.bytes)
  const newer = installation(fetcher, { runtime: runtime({ pin: () => next.pin }) })
  await newer.updateIfBehind()
  expect((await settled(newer)).operation?.phase).toBe('succeeded')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('treats a Cancel of an Update the user pressed as declining it too', async () => {
  await seedRelease(OLD)
  const held = heldServe()
  const subject = installation(held.fetcher)
  subject.install()
  const cancelled = subject.cancel(await runningId(subject))
  held.release()
  expect((await cancelled)?.phase).toBe('cancelled')
  await subject.updateIfBehind()
  await installation(held.fetcher).updateIfBehind()
  expect(held.fetcher).toHaveBeenCalledTimes(1)
  // Update stays offered, so the user can still take it.
  expect((await subject.status()).updatesAutomatically).toBeUndefined()
})

it('offers no Update while an automatic one will run, and offers it again after a failure', async () => {
  await seedRelease(OLD)
  const subject = installation(refuse())
  expect(await subject.status()).toMatchObject({
    installedVersion: '1.5.0',
    installedCurrent: false,
    updatesAutomatically: true
  })
  await subject.updateIfBehind()
  await settled(subject)
  expect((await subject.status()).updatesAutomatically).toBeUndefined()
  // With the kill switch off, Update is the only way, so it is offered.
  const off = installation(serve(), { updatesEnabled: () => false })
  expect((await off.status()).updatesAutomatically).toBeUndefined()
})

it('skips a server that new chats do not run', async () => {
  await seedRelease(OLD)
  const fetcher = serve()
  // Another program, or a signed-in agy, takes new chats on this host.
  const subject = installation(fetcher, { external: true })
  await subject.updateIfBehind()
  expect(fetcher).not.toHaveBeenCalled()
  expect((await subject.status()).updatesAutomatically).toBeUndefined()
})

it('stops a running automatic download when the kill switch is turned off, without declining it', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await seedRelease(OLD)
  let enabled = true
  const held = heldServe()
  const subject = installation(held.fetcher, { updatesEnabled: () => enabled })
  await subject.updateIfBehind()
  await runningId(subject)
  enabled = false
  subject.stopAutoUpdate()
  held.release()
  expect((await settled(subject)).operation?.phase).toBe('cancelled')
  expect(launches()).toMatchObject({ version: '1.5.0' })
  // Turned back on, it is an ordinary retry, not a declined release.
  enabled = true
  vi.setSystemTime(Date.now() + 61 * 60_000)
  const fetcher = serve()
  const later = installation(fetcher)
  await later.updateIfBehind()
  expect((await settled(later)).operation?.phase).toBe('succeeded')
})

it("leaves a user's Update alone when the kill switch is turned off", async () => {
  await seedRelease(OLD)
  const subject = installation(serve(), { updatesEnabled: () => false })
  subject.install()
  subject.stopAutoUpdate()
  expect((await settled(subject)).operation?.phase).toBe('succeeded')
})

describe('the managed CLI, which follows its latest release', () => {
  const cli = () => runtime({ updatesToPin: undefined, refreshPin: async () => undefined })

  it('keeps retrying a failed update hourly, without lengthening the wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await seedRelease(OLD)
    const fetcher = serve(Buffer.from('not the pinned server'))
    const subject = installation(fetcher, { runtime: cli() })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await subject.updateIfBehind()
      await settled(subject)
      expect(fetcher).toHaveBeenCalledTimes(attempt)
      await subject.updateIfBehind()
      expect(fetcher).toHaveBeenCalledTimes(attempt)
      vi.setSystemTime(Date.now() + 61 * 60_000)
    }
    // Nothing is written for it.
    expect(existsSync(join(data, 'agent-runtimes', '.server-auto-update.json'))).toBe(false)
  })

  it('retries a cancelled update an hour later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await seedRelease(OLD)
    const held = heldServe()
    const subject = installation(held.fetcher, { runtime: cli() })
    await subject.updateIfBehind()
    const cancelled = subject.cancel(await runningId(subject))
    held.release()
    expect((await cancelled)?.phase).toBe('cancelled')
    vi.setSystemTime(Date.now() + 61 * 60_000)
    await subject.updateIfBehind()
    expect((await settled(subject)).operation?.phase).toBe('succeeded')
    expect(held.fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('limits on automatic attempts', () => {
  const day = 24 * 60 * 60_000

  it('downloads a release that keeps failing at most three times in thirty days of restarts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await seedRelease(OLD)
    const fetcher = refuse()
    // An orcad that restarts every hour, each start running its check.
    for (let hour = 0; hour < 30 * 24; hour += 1) {
      const host = installation(fetcher)
      await host.updateIfBehind()
      if ((await host.status(false)).operation) {
        await settled(host)
      }
      vi.setSystemTime(Date.now() + 60 * 60_000)
    }
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('gives up after one checksum mismatch, which recurs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await seedRelease(OLD)
    const fetcher = serve(Buffer.from('not the pinned server'))
    const subject = installation(fetcher)
    await subject.updateIfBehind()
    expect((await settled(subject)).operation?.error).toMatch(/didn't match/)
    vi.setSystemTime(Date.now() + 30 * day)
    await installation(fetcher).updateIfBehind()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("gives up after one release that won't start on this host", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await seedRelease(OLD)
    const fetcher = serve()
    const probe = runtime({
      validate: async () => {
        throw new Error('needs a newer C library')
      }
    })
    const subject = installation(fetcher, { runtime: probe })
    await subject.updateIfBehind()
    expect((await settled(subject)).operation?.error).toMatch(/couldn't start on this host/)
    vi.setSystemTime(Date.now() + 30 * day)
    await installation(fetcher, { runtime: probe }).updateIfBehind()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(launches()).toMatchObject({ version: '1.5.0' })
  })

  it('treats a record written by a clock that was ahead as written now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await seedRelease(OLD)
    await writeRecord({ attempts: 1, lastAt: Date.now() + 365 * day })
    const fetcher = serve()
    await installation(fetcher).updateIfBehind()
    expect(fetcher).not.toHaveBeenCalled()
    vi.setSystemTime(Date.now() + 61 * 60_000)
    const later = installation(fetcher)
    await later.updateIfBehind()
    expect((await settled(later)).operation?.phase).toBe('succeeded')
  })

  it('ignores a record whose time is not a finite number', async () => {
    await seedRelease(OLD)
    await writeFile(
      recordFile(),
      `{"releaseId":"${runtimeReleaseId(PINNED.pin)}","attempts":1,"lastAt":1e999,"declined":false}`
    )
    const fetcher = serve()
    const subject = installation(fetcher)
    await subject.updateIfBehind()
    expect((await settled(subject)).operation?.phase).toBe('succeeded')
  })

  it('sweeps temporaries an interrupted write left, and forgets the record on Remove', async () => {
    await seedRelease(OLD)
    await writeRecord({ attempts: 1, lastAt: Date.now() })
    await writeFile(`${recordFile()}.123-abc.tmp`, '{')
    const subject = installation(serve())
    await subject.status()
    expect(existsSync(`${recordFile()}.123-abc.tmp`)).toBe(false)
    subject.remove()
    expect((await settled(subject)).operation?.phase).toBe('succeeded')
    expect(existsSync(recordFile())).toBe(false)
  })
})

describe('when Update is left out', () => {
  it('offers Update once this process has run its check, as when the kill switch comes back on', async () => {
    await seedRelease(OLD)
    let enabled = false
    const fetcher = serve()
    const subject = installation(fetcher, { updatesEnabled: () => enabled })
    await subject.updateIfBehind()
    enabled = true
    expect((await subject.status()).updatesAutomatically).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('offers Update when the check found new chats on another program', async () => {
    await seedRelease(OLD)
    let external = true
    const subject = new ManagedRuntimeInstallation('server-agent', runtime(), {
      dataDirectory: data,
      program: 'server',
      findExternal: async () => external,
      fence: (work) => work(),
      fetcher: serve()
    })
    await subject.updateIfBehind()
    external = false
    expect((await subject.status()).updatesAutomatically).toBeUndefined()
  })

  it('offers Update after an Update the user pressed fails while one was pending', async () => {
    await seedRelease(OLD)
    const subject = installation(refuse())
    expect((await subject.status()).updatesAutomatically).toBe(true)
    subject.install()
    expect((await settled(subject)).operation?.phase).toBe('failed')
    expect((await subject.status()).updatesAutomatically).toBeUndefined()
    expect((await installation(refuse()).status()).updatesAutomatically).toBeUndefined()
  })

  it('reads a Cancel at once, before the outcome reaches clients', async () => {
    await seedRelease(OLD)
    const held = heldServe()
    const subject = installation(held.fetcher)
    expect((await subject.status()).updatesAutomatically).toBe(true)
    subject.install()
    const id = await runningId(subject)
    const seen: (true | undefined)[] = []
    subject.subscribe(() => {
      void subject.status(false).then((state) => {
        if (state.operation?.phase === 'cancelled') {
          seen.push(state.updatesAutomatically)
        }
      })
    })
    const cancelled = subject.cancel(id)
    held.release()
    await cancelled
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen).not.toContain(true)
  })
})
