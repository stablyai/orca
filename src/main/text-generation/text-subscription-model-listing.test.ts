import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createTextSubscriptionCliProbe,
  nonEmptyModelListing,
  readTextSubscriptionModelListing
} from './text-subscription-cli-probe'
import { beginTextGenerationRequest } from './source-control-generation-lanes'
import { DEFAULT_POLL_MS } from '../rate-limits/service/service-types'

let root = ''
let program = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-model-listing-'))
  program = join(root, 'cli')
  writeFileSync(program, 'stamp-1')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function read(overrides: { identity?: string; configuration?: string; cwd?: string } = {}) {
  const probe = vi.fn(async () => 'model-a\nmodel-b')
  const listing = readTextSubscriptionModelListing({
    program,
    accountId: 'a',
    identity: overrides.identity ?? 'login-a',
    configuration: overrides.configuration ?? 'config-1',
    cwd: overrides.cwd ?? root,
    probe,
    parse: (output) => nonEmptyModelListing(output.split('\n'))
  })
  return { probe, listing }
}

describe('text subscription model listing cache', () => {
  it('reuses a parsed listing for the same install, login, config and cwd', async () => {
    expect(await read().listing).toEqual(['model-a', 'model-b'])
    const second = read()
    expect(await second.listing).toEqual(['model-a', 'model-b'])
    expect(second.probe).not.toHaveBeenCalled()
  })

  it.each([
    ['login', { identity: 'login-b' }],
    ['configuration', { configuration: 'config-2' }],
    ['cwd', { cwd: join(root, 'nested') }]
  ] as const)('re-probes after the %s changes', async (_part, overrides) => {
    await read().listing
    const changed = read(overrides)
    await changed.listing
    expect(changed.probe).toHaveBeenCalledOnce()
  })

  it('re-probes after the install changes or the poll interval passes', async () => {
    await read().listing
    utimesSync(program, new Date(), new Date(Date.now() + 60_000))
    const reinstalled = read()
    await reinstalled.listing
    expect(reinstalled.probe).toHaveBeenCalledOnce()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + DEFAULT_POLL_MS + 1)
    const expired = read()
    await expired.listing
    expect(expired.probe).toHaveBeenCalledOnce()
  })

  it('does not keep a failed parse', async () => {
    const failed = readTextSubscriptionModelListing({
      program,
      accountId: 'a',
      identity: 'login-a',
      configuration: 'config-1',
      cwd: root,
      probe: async () => '',
      parse: (output) => nonEmptyModelListing(output.split('\n').filter(Boolean))
    })
    expect(await failed).toBeNull()
    const retried = read()
    await retried.listing
    expect(retried.probe).toHaveBeenCalledOnce()
  })

  it('does not claim a spawn slot on a cache hit', async () => {
    const request = beginTextGenerationRequest('branch-name', root, 60_000, () => true)
    try {
      const claim = vi.spyOn(request, 'claimSpawn')
      const probe = createTextSubscriptionCliProbe({
        program: process.execPath,
        cwd: root,
        request,
        current: () => true
      })
      const list = () =>
        readTextSubscriptionModelListing({
          program: process.execPath,
          accountId: 'spawn-check',
          identity: 'login-a',
          configuration: 'config-1',
          cwd: root,
          probe: () => probe(['-e', 'process.stdout.write("model-a")'], process.env),
          parse: (output) => nonEmptyModelListing(output.split('\n'))
        })
      expect(await list()).toEqual(['model-a'])
      expect(await list()).toEqual(['model-a'])
      expect(claim).toHaveBeenCalledOnce()
    } finally {
      request.finish()
    }
  })
})
