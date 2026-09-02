import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDaemonFileLog, createNoopDaemonFileLog } from './daemon-file-log'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-file-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function readLines(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('createDaemonFileLog', () => {
  it('appends NDJSON lines with src/ts/pid/event and terse details', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    log.log('startup', { protocolVersion: 18 })
    log.log('session-created', { sessionId: 'abc', pid: 42 })

    const lines = readLines(filePath)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ src: 'daemon', event: 'startup', protocolVersion: 18 })
    expect(typeof lines[0].ts).toBe('string')
    expect(lines[0].pid).toBe(process.pid)
    expect(lines[1]).toMatchObject({ event: 'session-created', sessionId: 'abc', pid: 42 })
  })

  it('rotates at the byte cap and keeps only the configured rotated files', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath, { maxBytes: 150, maxRotatedFiles: 2 })
    for (let i = 0; i < 40; i++) {
      log.log('tick', { i })
    }

    expect(existsSync(filePath)).toBe(true)
    expect(existsSync(`${filePath}.1`)).toBe(true)
    expect(existsSync(`${filePath}.2`)).toBe(true)
    // Only 2 rotated files are retained — the oldest is dropped, not kept.
    expect(existsSync(`${filePath}.3`)).toBe(false)

    // The active file holds the most recent line.
    const active = readLines(filePath)
    expect(active.at(-1)).toMatchObject({ event: 'tick', i: 39 })
  })

  it('is fail-open when the log directory cannot be created', () => {
    // Make the parent a file so mkdir of the logs subdir fails (ENOTDIR).
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const filePath = join(blocker, 'logs', 'daemon.log')

    const log = createDaemonFileLog(filePath)
    expect(() => log.log('startup')).not.toThrow()
    expect(() => log.close()).not.toThrow()
    expect(existsSync(filePath)).toBe(false)
  })

  it('never throws from log() even for non-serializable details', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => log.log('weird', circular)).not.toThrow()
    // The bad line is dropped; a later good line still lands.
    log.log('ok')
    const lines = readLines(filePath)
    expect(lines.map((l) => l.event)).toEqual(['ok'])
  })

  it('close() writes a terminal marker and stops further writes', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    log.log('startup')
    log.close()
    log.log('after-close')

    const events = readLines(filePath).map((l) => l.event)
    expect(events).toEqual(['startup', 'daemon-log-closed'])
  })
})

describe('createNoopDaemonFileLog', () => {
  it('accepts log/close calls without touching the filesystem', () => {
    const log = createNoopDaemonFileLog()
    expect(() => {
      log.log('startup', { x: 1 })
      log.close()
    }).not.toThrow()
  })
})
