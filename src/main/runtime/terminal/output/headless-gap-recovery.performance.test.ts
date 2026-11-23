import { afterEach, expect, it, vi } from 'vitest'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { anchorStream, createRuntime, grid, headlessOf } from './headless-recovery-test-harness'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// A recovered model owns screen mode; no provider mirror may keep parsing its later output, and a rebuild that
// succeeds never parses its snapshot a second time for a screen read nobody made (#43889).
it.each([10, 100])(
  'recovers %i gapped terminals without a spare snapshot parse or a leftover mode scan per chunk',
  async (count) => {
    const runtime = createRuntime()
    const ptyIds = Array.from({ length: count }, (_, index) => `pty-recovered-${index}`)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer: async (ptyId): Promise<PtyProviderBufferSnapshot> => ({
        data: '\x1b[H\x1b[2Jrecovered',
        ...grid,
        seq: runtime.getPtyOutputSequence(ptyId),
        source: 'headless',
        alternateScreen: false
      })
    })
    const parses = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    try {
      for (const ptyId of ptyIds) {
        anchorStream(runtime, ptyId)
        runtime.onPtyData(ptyId, 'before\r\n', 1)
        runtime.notePtyDataGap(ptyId, 9)
      }
      await vi.waitFor(
        () => {
          for (const ptyId of ptyIds) {
            expect(headlessOf(runtime).readWholeScreenModel(ptyId)).not.toBeNull()
          }
        },
        { timeout: 20_000 }
      )
      expect(parses).toHaveBeenCalledTimes(0)
      const scan = vi.spyOn(TerminalKittyKeyboardModeTracker.prototype, 'scan')
      for (let chunk = 0; chunk < 5; chunk += 1) {
        for (const ptyId of ptyIds) {
          runtime.onPtyData(ptyId, `line ${chunk}\r\n`, 2)
        }
      }
      expect(scan).toHaveBeenCalledTimes(0)
    } finally {
      await Promise.all(ptyIds.map((ptyId) => runtime.onPtyExit(ptyId, 0)))
    }
  },
  30_000
)

// A read that started while recovery owned the screen must not reinstall the mirror when it lands after (#43889).
it.each([10, 100])(
  'keeps %i recovered terminals free of mode scans after a late ordinary read lands',
  async (count) => {
    const runtime = createRuntime()
    const ptyIds = Array.from({ length: count }, (_, index) => `pty-late-read-${index}`)
    const heldReads: (() => void)[] = []
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer: (ptyId, opts): Promise<PtyProviderBufferSnapshot> => {
        const reply = (): PtyProviderBufferSnapshot => ({
          data: '\x1b[H\x1b[2Jrecovered',
          ...grid,
          seq: runtime.getPtyOutputSequence(ptyId),
          source: 'headless',
          alternateScreen: false
        })
        if (opts?.recovery) {
          return Promise.resolve(reply())
        }
        return new Promise((resolve) => heldReads.push(() => resolve(reply())))
      }
    })
    try {
      const reads: Promise<unknown>[] = []
      for (const ptyId of ptyIds) {
        anchorStream(runtime, ptyId)
        runtime.onPtyData(ptyId, 'before\r\n', 1)
        runtime.notePtyDataGap(ptyId, 9)
        runtime.onPtyData(ptyId, 'suffix\r\n', 2)
        reads.push(runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: 0 }))
      }
      await vi.waitFor(
        () => {
          expect(heldReads).toHaveLength(count)
          for (const ptyId of ptyIds) {
            expect(headlessOf(runtime).readWholeScreenModel(ptyId)).not.toBeNull()
          }
        },
        { timeout: 20_000 }
      )
      for (const release of heldReads) {
        release()
      }
      await Promise.all(reads)
      const scan = vi.spyOn(TerminalKittyKeyboardModeTracker.prototype, 'scan')
      for (let chunk = 0; chunk < 5; chunk += 1) {
        for (const ptyId of ptyIds) {
          runtime.onPtyData(ptyId, `line ${chunk}\r\n`, 3)
        }
      }
      expect(scan).toHaveBeenCalledTimes(0)
    } finally {
      await Promise.all(ptyIds.map((ptyId) => runtime.onPtyExit(ptyId, 0)))
    }
  },
  30_000
)

// A screen the provider owned before the gap is read from its settled frame, as on main, not recaptured per read (#43889).
it.each([10, 100])(
  'captures each of %i provider-owned recovering screens once across repeated unchanged reads',
  async (count) => {
    const runtime = createRuntime()
    const ptyIds = Array.from({ length: count }, (_, index) => `pty-owned-${index}`)
    let readerCaptures = 0
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer: (ptyId, opts): Promise<PtyProviderBufferSnapshot> => {
        if (opts?.recovery) {
          return new Promise(() => {})
        }
        readerCaptures += 1
        return Promise.resolve({
          data: '\x1b[H\x1b[2Jprovider screen',
          ...grid,
          seq: runtime.getPtyOutputSequence(ptyId),
          source: 'headless',
          alternateScreen: true
        })
      }
    })
    try {
      for (const ptyId of ptyIds) {
        // A continued stream that no seed has settled: the provider owns its screen.
        anchorStream(runtime, ptyId)
        runtime.onPtyData(ptyId, 'before\r\n', 1)
        runtime.notePtyDataGap(ptyId, 9)
      }
      for (let round = 0; round < 10; round += 1) {
        for (const ptyId of ptyIds) {
          const screen = await headlessOf(runtime).readScreenProjection(ptyId)
          expect(screen?.lines).toEqual(['provider screen'])
        }
      }
      expect(readerCaptures).toBe(count)
    } finally {
      await Promise.all(ptyIds.map((ptyId) => runtime.onPtyExit(ptyId, 0)))
    }
  },
  30_000
)

// A preview of a provider-owned normal screen uses its raw tail, as on main; it never fetches a frame to discard (#43889).
it.each([10, 100])(
  'previews %i provider-owned normal recovering screens without reader captures',
  async (count) => {
    const runtime = createRuntime()
    const ptyIds = Array.from({ length: count }, (_, index) => `pty-preview-${index}`)
    let recoveryCaptures = 0
    let readerCaptures = 0
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer: (ptyId, opts): Promise<PtyProviderBufferSnapshot> => {
        if (opts?.recovery) {
          recoveryCaptures += 1
        } else {
          readerCaptures += 1
        }
        return Promise.resolve({
          data: '\x1b[H\x1b[2Jprovider screen',
          ...grid,
          // Recovery's snapshot predates its journal: it installs the normal-mode tracker but cannot rebuild.
          seq: opts?.recovery ? 0 : runtime.getPtyOutputSequence(ptyId),
          source: 'headless',
          alternateScreen: false
        })
      }
    })
    // Recovery's retry pacing runs on these clocks; waitFor advances them.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      for (const ptyId of ptyIds) {
        anchorStream(runtime, ptyId)
        runtime.onPtyData(ptyId, 'before\r\n', 1)
        runtime.notePtyDataGap(ptyId, 9)
      }
      await vi.waitFor(() => expect(recoveryCaptures).toBeGreaterThanOrEqual(count))
      await new Promise((resolve) => setImmediate(resolve))
      for (let round = 0; round < 10; round += 1) {
        for (const ptyId of ptyIds) {
          runtime.onPtyData(ptyId, `line ${round}\r\n`, 2)
          const shown = await headlessOf(runtime).visibleSnapshotPreview(ptyId, 'raw tail')
          expect(shown.preview).toBe('raw tail')
        }
      }
      expect(readerCaptures).toBe(0)
    } finally {
      await Promise.all(ptyIds.map((ptyId) => runtime.onPtyExit(ptyId, 0)))
    }
  },
  30_000
)

// A rebuilding screen answers from its kept frame: parsed once when kept, never recaptured or reparsed per read (#43889).
it.each([10, 100])(
  'answers %i rebuilding screens from their kept frames without recapturing or reparsing',
  async (count) => {
    const runtime = createRuntime()
    const ptyIds = Array.from({ length: count }, (_, index) => `pty-kept-${index}`)
    let recoveryCaptures = 0
    let readerCaptures = 0
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer: (_ptyId, opts): Promise<PtyProviderBufferSnapshot> => {
        if (opts?.recovery) {
          recoveryCaptures += 1
        } else {
          readerCaptures += 1
        }
        // After the pre-gap frame but before the journal: kept, yet each rebuild fails and frees its slot.
        return Promise.resolve({
          data: '\x1b[H\x1b[2Jkept',
          ...grid,
          seq: 10,
          source: 'headless'
        })
      }
    })
    const parses = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      for (const ptyId of ptyIds) {
        // A fresh stream: the model owns its screen until the gap.
        runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'reset' })
        runtime.anchorProviderSequence(ptyId, 0, 0)
        runtime.onPtyData(ptyId, 'before\r\n', 1)
        runtime.notePtyDataGap(ptyId, 9)
      }
      await vi.waitFor(() => expect(recoveryCaptures).toBeGreaterThanOrEqual(count))
      for (let round = 0; round < 10; round += 1) {
        for (const ptyId of ptyIds) {
          const screen = await headlessOf(runtime).readScreenProjection(ptyId)
          expect(screen?.lines).toEqual(['kept'])
        }
      }
      expect(parses).toHaveBeenCalledTimes(count)
      expect(readerCaptures).toBe(0)
    } finally {
      await Promise.all(ptyIds.map((ptyId) => runtime.onPtyExit(ptyId, 0)))
    }
  },
  30_000
)
