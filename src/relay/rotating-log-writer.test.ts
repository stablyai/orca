/**
 * Regression: relay.log grows unbounded on long-lived relays.
 *
 * The relay is launched detached with `> relay.log 2>&1`, which truncates only
 * at relaunch; a relay that stays up for days accumulates per-stream stderr
 * lines forever. These tests assert the in-process rotator caps size, keeps one
 * archived generation, and always leaves the CURRENT log at relay.log so the
 * `tail -100 relay.log` diagnostics workflow keeps working.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

import { RotatingLogWriter, installRelayLogRotation } from './rotating-log-writer'

describe('RotatingLogWriter', () => {
  let dir: string
  let logPath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'relay-log-rot-'))
    logPath = path.join(dir, 'relay.log')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rotates relay.log -> relay.log.1 at the cap and keeps the current log tail-able', () => {
    const cap = 4 * 1024
    const writer = new RotatingLogWriter(logPath, cap)
    try {
      const line = `${'a'.repeat(200)}\n`
      // Write well past the cap so at least one rotation happens.
      for (let i = 0; i < 60; i += 1) {
        writer.write(line)
      }

      // Current log exists at relay.log (tail target) and is under the cap.
      expect(existsSync(logPath)).toBe(true)
      expect(statSync(logPath).size).toBeLessThanOrEqual(cap)
      // Exactly one archived generation.
      expect(existsSync(`${logPath}.1`)).toBe(true)
      expect(existsSync(`${logPath}.2`)).toBe(false)

      // The most recent lines are in the current log (tail-ability).
      writer.write('MARKER-LAST\n')
      expect(readFileSync(logPath, 'utf-8')).toContain('MARKER-LAST')
    } finally {
      writer.dispose()
    }
  })

  it('preserves pre-existing boot output already in relay.log (append, not truncate)', () => {
    writeFileSync(logPath, 'BOOT-LINE-FROM-SHELL-REDIRECT\n')
    const writer = new RotatingLogWriter(logPath, 1024 * 1024)
    try {
      writer.write('runtime line\n')
      const contents = readFileSync(logPath, 'utf-8')
      expect(contents).toContain('BOOT-LINE-FROM-SHELL-REDIRECT')
      expect(contents).toContain('runtime line')
    } finally {
      writer.dispose()
    }
  })

  it('bounds a single oversized log write and keeps its newest tail', () => {
    const cap = 1024
    const writer = new RotatingLogWriter(logPath, cap)
    try {
      writer.write(`${'old'.repeat(1000)}LATEST-CONTEXT`)
      expect(statSync(logPath).size).toBeLessThanOrEqual(cap)
      expect(readFileSync(logPath, 'utf-8')).toContain('LATEST-CONTEXT')
    } finally {
      writer.dispose()
    }
  })

  it('caps total footprint to ~2x maxBytes (current + one archive)', () => {
    const cap = 8 * 1024
    const writer = new RotatingLogWriter(logPath, cap)
    try {
      const line = `${'z'.repeat(256)}\n`
      for (let i = 0; i < 500; i += 1) {
        writer.write(line)
      }
      const currentSize = statSync(logPath).size
      const archiveSize = existsSync(`${logPath}.1`) ? statSync(`${logPath}.1`).size : 0
      // Never more than the current file + a single archived generation.
      expect(currentSize).toBeLessThanOrEqual(cap)
      expect(archiveSize).toBeLessThanOrEqual(cap)
      expect(existsSync(`${logPath}.2`)).toBe(false)
    } finally {
      writer.dispose()
    }
  })

  it('caps size via truncate-in-place when rename cannot succeed (Windows shell-handle case)', () => {
    // Model the platform where renameSync fails (e.g. Windows, where the launch
    // shell's own `1>relay.log` handle blocks renaming the live file): make the
    // archive path a directory so renameSync(logPath, `${logPath}.1`) throws.
    mkdirSync(`${logPath}.1`, { recursive: true })
    const cap = 4 * 1024
    const writer = new RotatingLogWriter(logPath, cap)
    try {
      const line = `${'q'.repeat(200)}\n`
      for (let i = 0; i < 100; i += 1) {
        writer.write(line)
      }
      // The cap still holds via truncate-in-place even though no archive was made.
      expect(statSync(logPath).size).toBeLessThanOrEqual(cap)
      writer.write('MARKER-LAST\n')
      expect(readFileSync(logPath, 'utf-8')).toContain('MARKER-LAST')
    } finally {
      writer.dispose()
    }
  })

  it('installRelayLogRotation routes stdout/stderr through the rotator and restores', () => {
    const cap = 2 * 1024
    const { restore } = installRelayLogRotation(logPath, cap)
    try {
      process.stderr.write('via-stderr-line\n')
      process.stdout.write('via-stdout-line\n')
      expect(readFileSync(logPath, 'utf-8')).toContain('via-stderr-line')
      expect(readFileSync(logPath, 'utf-8')).toContain('via-stdout-line')
    } finally {
      restore()
    }
    // After restore, process.stderr no longer targets the rotator file. Spy so
    // the assertion write does not leak to the real test-runner stderr.
    const sizeAfterRestore = statSync(logPath).size
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      process.stderr.write('should-not-be-in-relay-log\n')
    } finally {
      spy.mockRestore()
    }
    expect(statSync(logPath).size).toBe(sizeAfterRestore)
  })

  it('leaves the original streams active when the log cannot be opened', () => {
    mkdirSync(logPath)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const { writer, restore } = installRelayLogRotation(logPath)
      expect(writer.active).toBe(false)
      process.stdout.write('stdout fallback\n')
      process.stderr.write('stderr fallback\n')
      expect(stdout).toHaveBeenCalledWith('stdout fallback\n')
      expect(stderr).toHaveBeenCalledWith('stderr fallback\n')
      restore()
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })
})
