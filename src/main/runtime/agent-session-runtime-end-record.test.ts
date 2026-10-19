// What a runtime records about itself: a start when its store opens, and its end on a graceful exit.
// A crash is only a runtime known to have started and never ended; anything else names no cause.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DurableFileWrite from '../durable-file-write'

const writes = vi.hoisted(() => ({ fail: false }))
vi.mock('../durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  return {
    ...actual,
    writeFileDurableSync: (...args: Parameters<typeof actual.writeFileDurableSync>) => {
      if (writes.fail) {
        throw new Error('ENOSPC: no space left on device')
      }
      actual.writeFileDurableSync(...args)
    }
  }
})

import {
  beginAgentSessionRuntimeRecord,
  readAgentSessionRuntimeEnds,
  recordAgentSessionRuntimeEnd,
  recordAgentSessionRuntimeEndOnExit
} from './agent-session-runtime-end-record'
import { tearDownRuntime, type InstalledRuntime } from './structured-agent-session-runtime-teardown'

const RUNTIME_A = '0000000a-0000-4000-8000-000000000000'
const RUNTIME_B = '0000000b-0000-4000-8000-000000000000'

let directory: string

beforeEach(async () => {
  writes.fail = false
  directory = await mkdtemp(join(tmpdir(), 'orca-runtime-end-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function runtimesDirectory(): string {
  return join(directory, 'agent-session-runtimes')
}

describe('what a runtime records about itself', () => {
  it('reads as a crash once it started and never ended', () => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    expect(readAgentSessionRuntimeEnds(directory)?.get(RUNTIME_A)).toBe('crash')
  })

  it.each(['quit', 'update'] as const)('reads as the %s it recorded as it ended', (trigger) => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    recordAgentSessionRuntimeEnd(trigger, 2)
    expect(readAgentSessionRuntimeEnds(directory)?.get(RUNTIME_A)).toBe(trigger)
  })

  it('keeps the first end it recorded', () => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    recordAgentSessionRuntimeEnd('update', 2)
    recordAgentSessionRuntimeEnd('quit', 3)
    expect(readAgentSessionRuntimeEnds(directory)?.get(RUNTIME_A)).toBe('update')
  })

  it('names no cause for a runtime it has no record of', () => {
    expect(readAgentSessionRuntimeEnds(directory)).toEqual(new Map())
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    expect(readAgentSessionRuntimeEnds(directory)?.has(RUNTIME_B)).toBe(false)
  })

  it('names no cause for a record it cannot read, and the next start writes its own', async () => {
    await mkdir(runtimesDirectory(), { recursive: true })
    await writeFile(join(runtimesDirectory(), `${RUNTIME_A}.json`), '{not json')
    expect(readAgentSessionRuntimeEnds(directory)?.has(RUNTIME_A)).toBe(false)

    beginAgentSessionRuntimeRecord(directory, RUNTIME_B, 1)
    recordAgentSessionRuntimeEnd('quit', 2)
    expect(readAgentSessionRuntimeEnds(directory)?.get(RUNTIME_B)).toBe('quit')
  })

  it('names no cause when the records cannot be listed', async () => {
    await writeFile(runtimesDirectory(), 'not a directory')
    expect(readAgentSessionRuntimeEnds(directory)).toBeNull()
  })

  it('keeps only the newest records, so a pruned runtime names no cause', async () => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    // The oldest record by far.
    await utimes(join(runtimesDirectory(), `${RUNTIME_A}.json`), 1, 1)
    for (let index = 0; index < 16; index += 1) {
      beginAgentSessionRuntimeRecord(
        directory,
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        index
      )
    }
    const ends = readAgentSessionRuntimeEnds(directory)
    expect(ends?.size).toBe(16)
    expect(ends?.has(RUNTIME_A)).toBe(false)
  })

  it("never loses another runtime's record to its own writes", () => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    beginAgentSessionRuntimeRecord(directory, RUNTIME_B, 2)
    recordAgentSessionRuntimeEnd('quit', 3)
    expect(readAgentSessionRuntimeEnds(directory)).toEqual(
      new Map([
        [RUNTIME_A, 'crash'],
        [RUNTIME_B, 'quit']
      ])
    )
  })

  it('never fails the exit when it cannot be written', async () => {
    await writeFile(runtimesDirectory(), 'not a directory')
    expect(() => beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)).not.toThrow()
    expect(() => recordAgentSessionRuntimeEnd('quit', 2)).not.toThrow()
  })

  it('keeps its end when the same runtime records its start again during the quit', () => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    recordAgentSessionRuntimeEnd('update', 2)
    // A host reinstalled by a request that landed during the quit opens its store again.
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 3)
    expect(readAgentSessionRuntimeEnds(directory)?.get(RUNTIME_A)).toBe('update')
  })

  it('names no cause, rather than a crash, when its end could not be written', () => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    writes.fail = true
    recordAgentSessionRuntimeEnd('quit', 2)
    expect(readAgentSessionRuntimeEnds(directory)?.has(RUNTIME_A)).toBe(false)
  })

  it('reads a clean process exit nothing else recorded as a quit, and any other exit as nothing', () => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    expect(process.listeners('exit')).toContain(recordAgentSessionRuntimeEndOnExit)
    recordAgentSessionRuntimeEndOnExit(1)
    expect(readAgentSessionRuntimeEnds(directory)?.get(RUNTIME_A)).toBe('crash')
    recordAgentSessionRuntimeEndOnExit(0)
    expect(readAgentSessionRuntimeEnds(directory)?.get(RUNTIME_A)).toBe('quit')
  })

  it('leaves no temp files behind', async () => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    recordAgentSessionRuntimeEnd('quit', 2)
    expect(await readdir(runtimesDirectory())).toEqual([`${RUNTIME_A}.json`])
  })
})

describe('a quit', () => {
  it('records its end before it waits on anything, so a quit that never finishes is still a quit', () => {
    beginAgentSessionRuntimeRecord(directory, RUNTIME_A, 1)
    const installed = {
      host: { stopDelivery: vi.fn(), flushAllStreamedEvents: vi.fn() },
      adapter: { closeAll: vi.fn() },
      journalDatabase: { stateDirectory: directory, close: vi.fn() },
      // A recovery that never drains: the quit's deadline ends the process here.
      waitForRecovery: () => new Promise<void>(() => {})
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown reads only the members stubbed above before it parks on the recovery wait.
    void tearDownRuntime(installed as unknown as InstalledRuntime, 'update')

    expect(readAgentSessionRuntimeEnds(directory)?.get(RUNTIME_A)).toBe('update')
    expect(installed.host.flushAllStreamedEvents).not.toHaveBeenCalled()
    expect(existsSync(join(runtimesDirectory(), `${RUNTIME_A}.json`))).toBe(true)
  })
})
