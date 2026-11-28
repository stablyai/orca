import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as BundleIdentifierModule from '../macos-bundle-identifier'
import {
  MacosTccPromptWatch,
  type LogStreamChild,
  isOwnAttributedPrompt
} from './macos-tcc-prompt-watch'

// The running bundle resolves to Orca, so tests can tell a fallback apart from an explicit override.
vi.mock('../macos-bundle-identifier', async (importOriginal) => ({
  ...(await importOriginal<typeof BundleIdentifierModule>()),
  getMacBundleIdentifier: () => 'com.stablyai.orca'
}))

// Derived fixture: an agent accesses files while Orca is held responsible (#9756).
const ORCA_APPDATA_LINE =
  '2026-07-27 15:40:02.001 Df tccd[79149:c81551c] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=80871.99, service=kTCCServiceSystemPolicyAppData, subject=Sub:{node-5555494487fbc7467d473fd8b0a397018cbf954b}Resp:{TCCDProcess: identifier=com.stablyai.orca, pid=47548, auid=501, euid=501, binary_path=/opt/homebrew/Cellar/node/26.5.0/bin/node},'

describe('isOwnAttributedPrompt', () => {
  it('accepts the running bundle and its detached terminal helper, whatever it is named', () => {
    for (const own of ['com.stablyai.orca', 'com.stablyai.orca.dev', 'com.example.fork']) {
      for (const id of [own, `${own}.helper`]) {
        expect(
          isOwnAttributedPrompt(
            {
              service: 'kTCCServiceSystemPolicyAppData',
              accessingIdentifier: 'find',
              responsibleIdentifier: id
            },
            own
          )
        ).toBe(true)
      }
    }
  })

  it('rejects another app that happens to share a prefix, and an unidentifiable bundle', () => {
    const event = {
      service: 'kTCCServiceSystemPolicyAppData',
      accessingIdentifier: 'find',
      responsibleIdentifier: 'com.stablyai.orcafake'
    }
    expect(isOwnAttributedPrompt(event, 'com.stablyai.orca')).toBe(false)
    expect(
      isOwnAttributedPrompt({ ...event, responsibleIdentifier: 'com.stablyai.orca' }, null)
    ).toBe(false)
  })

  it('rejects the id every unpackaged Electron app shares, and its helper', () => {
    for (const id of ['com.github.Electron', 'com.github.Electron.helper']) {
      expect(
        isOwnAttributedPrompt(
          {
            service: 'kTCCServiceSystemPolicyAppData',
            accessingIdentifier: 'find',
            responsibleIdentifier: id
          },
          'com.github.Electron'
        )
      ).toBe(false)
    }
  })

  it('rejects dialogs another app is responsible for', () => {
    expect(
      isOwnAttributedPrompt(
        {
          service: 'kTCCServiceSystemPolicyAppData',
          accessingIdentifier: 'find',
          responsibleIdentifier: 'com.apple.Terminal'
        },
        'com.stablyai.orca'
      )
    ).toBe(false)
  })
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('MacosTccPromptWatch', () => {
  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('treats an explicit null identifier as unidentifiable instead of the running bundle', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const stdout = new PassThrough()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watcher only touches stdin/stdout/kill and EventEmitter events, all provided here.
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      kill: () => true
    }) as unknown as LogStreamChild
    const onPrompt = vi.fn()
    const watch = new MacosTccPromptWatch({
      onPrompt,
      spawnLogStream: () => child,
      ownIdentifier: null
    })
    watch.start()

    stdout.write(`${ORCA_APPDATA_LINE}\n`)
    await new Promise((resolve) => {
      setImmediate(resolve)
    })

    expect(onPrompt).not.toHaveBeenCalled()
    watch.stop()
  })
})
