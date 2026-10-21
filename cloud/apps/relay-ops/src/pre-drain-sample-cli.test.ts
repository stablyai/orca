import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { relayOpsEnvironment } from './environment-config.js'
import { parsePreDrainSampleArgs, runPreDrainSampleCli } from './pre-drain-sample-cli.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function membershipFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'relay-pre-drain-selector-'))
  directories.push(directory)
  const path = join(directory, 'selector.json')
  writeFileSync(path, JSON.stringify({
    existingOnly: relayOpsEnvironment('production').cells.map((cell) => cell.cellId),
    migrationOnly: [],
    general: []
  }))
  return path
}

function args(overrides: Record<string, string> = {}): string[] {
  const values: Record<string, string> = {
    '--target-cell-id': 'production-gce-c25',
    '--target-hosts': '1200',
    '--expected-selector-generation': '40',
    '--selector-membership-file': membershipFile(),
    '--wave-index': '2',
    '--selector-wave-delta': '2',
    ...overrides
  }
  return Object.entries(values).flatMap(([name, value]) => [name, value])
}

describe('pre-drain sample CLI', () => {
  it('requires every option exactly once and nothing else', () => {
    expect(() => parsePreDrainSampleArgs(['--', ...args()])).not.toThrow()
    const full = args()
    for (let index = 0; index < full.length; index += 2) {
      const missing = [...full.slice(0, index), ...full.slice(index + 2)]
      expect(() => parsePreDrainSampleArgs(missing)).toThrow('usage')
    }
    expect(() => parsePreDrainSampleArgs([...full, '--wave-index', '2'])).toThrow('usage')
    expect(() => parsePreDrainSampleArgs([...full, '--skip-window', '1'])).toThrow('usage')
    expect(() => parsePreDrainSampleArgs(args({ '--target-hosts': '-1' }))).toThrow('usage')
    expect(() => parsePreDrainSampleArgs(args({ '--target-hosts': '' }))).toThrow('usage')
  })

  it('rejects a target cell the environment does not configure', async () => {
    await expect(runPreDrainSampleCli(args({ '--target-cell-id': 'production-gce-c99' }), {
      collect: async () => { throw new Error('must not sample') },
      readHardRules: async () => { throw new Error('must not sample') }
    })).rejects.toThrow('target cell is unknown')
  })

  it('rejects a wave index or selector delta no wave produces', async () => {
    for (const overrides of [{ '--wave-index': '10' }, { '--selector-wave-delta': '1' }]) {
      await expect(runPreDrainSampleCli(args(overrides), {
        collect: async () => { throw new Error('must not sample') },
        readHardRules: async () => { throw new Error('must not sample') }
      })).rejects.toThrow('wave index or selector wave delta is invalid')
    }
  })

  it('sizes the window from the target hosts and reports the verdict', async () => {
    let clock = Date.parse('2026-10-01T12:00:00.000Z')
    const lines: string[] = []
    let collected = 0
    // A sample that cannot be judged green trips the run, which is enough to see the window.
    await expect(runPreDrainSampleCli(args(), {
      now: () => clock,
      wait: async (ms) => { clock += ms },
      collect: async () => {
        collected += 1
        throw new Error('collector down')
      },
      readHardRules: async () => ({
        cellProcessExits: 0,
        unattributedExitInstances: [],
        director503PeakPerMinute: 0,
        directorConcurrencyP99: 1
      }),
      print: (line) => lines.push(line)
    })).rejects.toThrow('relay pre-drain sample tripped')
    const events = lines.map((line) => JSON.parse(line))
    expect(events[0]).toEqual({
      event: 'relay_pre_drain_sample_window',
      targetCellId: 'production-gce-c25',
      targetHosts: 1200,
      windowMinutes: 5
    })
    expect(events.at(-1)).toMatchObject({ event: 'relay_pre_drain_sample_tripped' })
    expect(collected).toBe(3)
  })
})
