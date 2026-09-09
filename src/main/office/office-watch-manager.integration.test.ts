/**
 * Watch lifecycle against the real binary.
 *
 * The property under test is the one the plan calls out by name: closing a preview must leave no
 * `officecli` process and no listening port. That cannot be asserted against a mock — a mock would
 * only prove we called stop, not that anything stopped.
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeOfficecli } from './office-probe-service'
import { refreshOfficeWatch } from './office-watch-refresh'
import { startOfficeWatch, stopAllOfficeWatches, stopOfficeWatch } from './office-watch-manager'

const FIXTURE = join(__dirname, '__fixtures__', 'sample.pptx')

let installed = false
let directory = ''
let document = ''

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(1_000)
    const settle = (answered: boolean): void => {
      socket.destroy()
      resolve(answered)
    }
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

beforeAll(async () => {
  const probe = await probeOfficecli()
  installed = probe.ok && probe.installed && probe.supportsWatch
  directory = await mkdtemp(join(tmpdir(), 'orca-office-watch-'))
  document = join(directory, 'deck.pptx')
  await copyFile(FIXTURE, document)
}, 60_000)

afterAll(async () => {
  await stopAllOfficeWatches()
  await rm(directory, { recursive: true, force: true })
})

describe('office watch lifecycle', () => {
  it('starts, serves, refreshes and stops without leaving a listener', async () => {
    if (!installed) {
      return
    }
    const started = await startOfficeWatch(document)
    expect(started.ok).toBe(true)
    if (!started.ok) {
      return
    }
    expect(await portAnswers(started.port)).toBe(true)

    // A second open of the same document must reuse the session, not race into a second server
    // and hit the tool's one-watch-per-file refusal.
    const again = await startOfficeWatch(document)
    expect(again.ok && again.port).toBe(started.port)

    // Refresh pushes a re-render through /api/switch; the server keeps serving either way.
    await expect(refreshOfficeWatch(document)).resolves.toEqual({ ok: true })

    await expect(stopOfficeWatch(document)).resolves.toEqual({ ok: true })
    // Give the child's teardown a moment; the assertion is that the port is genuinely released.
    for (let attempt = 0; attempt < 20 && (await portAnswers(started.port)); attempt += 1) {
      await new Promise((done) => setTimeout(done, 100))
    }
    expect(await portAnswers(started.port)).toBe(false)
  }, 120_000)

  it('refuses a format it cannot watch before spawning anything', async () => {
    await expect(startOfficeWatch(join(directory, 'notes.doc'))).resolves.toEqual({
      ok: false,
      code: 'OFFICECLI_UNSUPPORTED_FORMAT'
    })
  })

  it('reports a refresh with no session rather than pretending it happened', async () => {
    const outcome = await refreshOfficeWatch(document)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.code).toBe('OFFICE_WATCH_NOT_RUNNING')
  })
})
