import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MacosTccPromptWatch,
  type LogStreamChild,
  isOrcaAttributedPrompt,
  parseTccPromptEvent
} from './macos-tcc-prompt-watch'

// Captured verbatim from `log stream --predicate 'subsystem == "com.apple.TCC"'`
// on macOS 26.5 while a real consent dialog was displayed and denied.
const REAL_PROMPT_LINE =
  '2026-07-27 15:35:26.136 Df tccd[79149:c81551c] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=80871.81, service=kTCCServiceSystemPolicyDocumentsFolder, subject=Sub:{com.orca.tccprobe.shapecapture}Resp:{TCCDProcess: identifier=com.orca.tccprobe.shapecapture, pid=74171, auid=501, euid=501, binary_path=/private/tmp/tccprobe/TccProbe.app/Contents/MacOS/TccProbe},'

// Same shape, but the #9756 case: an agent CLI accesses, Orca is held responsible.
const ORCA_APPDATA_LINE =
  '2026-07-27 15:40:02.001 Df tccd[79149:c81551c] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=80871.99, service=kTCCServiceSystemPolicyAppData, subject=Sub:{node-5555494487fbc7467d473fd8b0a397018cbf954b}Resp:{TCCDProcess: identifier=com.stablyai.orca, pid=47548, auid=501, euid=501, binary_path=/opt/homebrew/Cellar/node/26.5.0/bin/node},'

// Preflight checks dominate the TCC subsystem and must never count as a dialog.
const PREFLIGHT_LINE =
  '2026-07-27 15:23:26.420 Df tccd[79149:c7d3abb] [com.apple.TCC:access] AUTHREQ_CTX: msgID=36906.2, function=<private>, service=kTCCServiceMicrophone, preflight=yes, query=1, client_dict=(null), daemon_dict=<private>'

describe('parseTccPromptEvent', () => {
  it('parses a real captured AUTHREQ_PROMPTING line', () => {
    expect(parseTccPromptEvent(REAL_PROMPT_LINE)).toEqual({
      service: 'kTCCServiceSystemPolicyDocumentsFolder',
      accessingIdentifier: 'com.orca.tccprobe.shapecapture',
      responsibleIdentifier: 'com.orca.tccprobe.shapecapture',
      binaryPath: '/private/tmp/tccprobe/TccProbe.app/Contents/MacOS/TccProbe'
    })
  })

  it('separates the accessing binary from the responsible app', () => {
    const event = parseTccPromptEvent(ORCA_APPDATA_LINE)
    // The whole point of #9756: the dialog says Orca, but node did the access.
    expect(event?.responsibleIdentifier).toBe('com.stablyai.orca')
    expect(event?.accessingIdentifier).toBe('node-5555494487fbc7467d473fd8b0a397018cbf954b')
    expect(event?.binaryPath).toBe('/opt/homebrew/Cellar/node/26.5.0/bin/node')
  })

  it('ignores preflight checks, the log header, and malformed lines', () => {
    expect(parseTccPromptEvent(PREFLIGHT_LINE)).toBeNull()
    expect(parseTccPromptEvent('Filtering the log data using "subsystem == ..."')).toBeNull()
    expect(parseTccPromptEvent('')).toBeNull()
    // Has the marker but no parseable identities — must not yield a partial event.
    expect(parseTccPromptEvent('AUTHREQ_PROMPTING: msgID=1.2,')).toBeNull()
  })
})

describe('isOrcaAttributedPrompt', () => {
  it('accepts the app and detached terminal helper across Orca build identities', () => {
    for (const id of [
      'com.stablyai.orca',
      'com.stablyai.orca.helper',
      'com.stablyai.orca.dev',
      'com.stablyai.orca.dev.helper',
      'com.stablyai.orca.local',
      'com.stablyai.orca.local.helper'
    ]) {
      expect(
        isOrcaAttributedPrompt({
          service: 'kTCCServiceSystemPolicyAppData',
          accessingIdentifier: 'find',
          responsibleIdentifier: id
        })
      ).toBe(true)
    }
  })

  it('rejects dialogs another app is responsible for', () => {
    expect(
      isOrcaAttributedPrompt({
        service: 'kTCCServiceSystemPolicyAppData',
        accessingIdentifier: 'find',
        responsibleIdentifier: 'com.apple.Terminal'
      })
    ).toBe(false)
  })

  it('rejects unrelated services even when Orca is responsible', () => {
    expect(
      isOrcaAttributedPrompt({
        service: 'kTCCServiceMicrophone',
        accessingIdentifier: 'orca',
        responsibleIdentifier: 'com.stablyai.orca'
      })
    ).toBe(false)
  })
})

function createFakeLogStream(): {
  child: LogStreamChild
  stdout: PassThrough
  killed: string[]
} {
  const stdout = new PassThrough()
  const killed: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    kill: (signal?: string) => {
      killed.push(signal ?? 'SIGTERM')
      return true
    }
  }) as unknown as LogStreamChild
  return { child, stdout, killed }
}

// Why: the watcher is darwin-gated, so CI (Linux) would silently no-op every
// assertion below unless the platform is pinned. The gate itself is covered by
// the non-darwin case at the end of this block.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

describe('MacosTccPromptWatch', () => {
  beforeEach(() => {
    setPlatform('darwin')
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('never spawns a log reader off macOS', () => {
    setPlatform('linux')
    const spawnLogStream = vi.fn()
    const watch = new MacosTccPromptWatch({ onPrompt: vi.fn(), spawnLogStream })
    watch.start()
    expect(spawnLogStream).not.toHaveBeenCalled()
  })

  it('reports only Orca-attributed dialogs from a live stream', async () => {
    const { child, stdout } = createFakeLogStream()
    const onPrompt = vi.fn()
    const watch = new MacosTccPromptWatch({ onPrompt, spawnLogStream: () => child })
    watch.start()

    stdout.write('Filtering the log data using "subsystem == ..."\n')
    stdout.write(`${PREFLIGHT_LINE}\n`)
    stdout.write(`${REAL_PROMPT_LINE}\n`) // another app is responsible
    stdout.write(`${ORCA_APPDATA_LINE}\n`)
    await new Promise((resolve) => {
      setImmediate(resolve)
    })

    expect(onPrompt).toHaveBeenCalledTimes(1)
    expect(onPrompt.mock.calls[0][0]).toMatchObject({
      service: 'kTCCServiceSystemPolicyAppData',
      responsibleIdentifier: 'com.stablyai.orca'
    })
    watch.stop()
  })

  it('kills the child on stop so it cannot outlive app quit', () => {
    const { child, killed } = createFakeLogStream()
    const watch = new MacosTccPromptWatch({ onPrompt: vi.fn(), spawnLogStream: () => child })
    watch.start()
    watch.stop()
    expect(killed).toEqual(['SIGTERM'])
  })

  it('restarts once after an unexpected termination without creating a retry loop', async () => {
    const first = createFakeLogStream()
    const second = createFakeLogStream()
    const spawnLogStream = vi
      .fn<() => LogStreamChild>()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child)
    const watch = new MacosTccPromptWatch({
      onPrompt: vi.fn(),
      spawnLogStream,
      restartDelayMs: 0
    })
    watch.start()

    first.child.emit('error', new Error('logd restarted'))
    first.child.emit('exit', 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spawnLogStream).toHaveBeenCalledTimes(2)

    second.child.emit('exit', 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spawnLogStream).toHaveBeenCalledTimes(2)
    watch.stop()
  })

  it('cancels a pending restart when stopped', async () => {
    const first = createFakeLogStream()
    const spawnLogStream = vi.fn(() => first.child)
    const watch = new MacosTccPromptWatch({
      onPrompt: vi.fn(),
      spawnLogStream,
      restartDelayMs: 0
    })
    watch.start()
    first.child.emit('exit', 1)
    watch.stop()

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spawnLogStream).toHaveBeenCalledOnce()
  })

  it('does not restart after stop, and survives a spawn failure', () => {
    const spawnLogStream = vi.fn(() => {
      throw new Error('log binary unavailable')
    })
    const watch = new MacosTccPromptWatch({ onPrompt: vi.fn(), spawnLogStream })
    expect(() => watch.start()).not.toThrow()

    const { child } = createFakeLogStream()
    const afterStop = new MacosTccPromptWatch({
      onPrompt: vi.fn(),
      spawnLogStream: () => child
    })
    afterStop.stop()
    afterStop.start()
    // Why: quit ordering can call stop() before start(); it must not leave a live child behind.
    expect(afterStop['child']).toBeNull()
  })
})
