import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as BrowserClientHostIdModule from './browser-client-host-id'

function profileDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'orca-host-id-'))
}

async function freshModule(): Promise<typeof BrowserClientHostIdModule> {
  vi.resetModules()
  return await import('./browser-client-host-id')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('browser client host id', () => {
  it('answers the same durable id to every launch of one profile', async () => {
    const directory = profileDirectory()

    const first = await freshModule()
    first.initializeBrowserClientHostId(directory)
    const second = await freshModule()
    second.initializeBrowserClientHostId(directory)

    expect(first.getBrowserClientHostId()).toBe(second.getBrowserClientHostId())
  })

  it('keeps the id a renderer already holds when startup resolves the profile too late', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const module = await freshModule()

    // The order this guards against: a window stamped its argv from the process-local mint, so
    // adopting the durable id now would leave that renderer answering to a name nothing else uses.
    const stamped = module.getBrowserClientHostId()
    module.initializeBrowserClientHostId(profileDirectory())

    expect(module.getBrowserClientHostId()).toBe(stamped)
    expect(warn).toHaveBeenCalled()
  })
})
