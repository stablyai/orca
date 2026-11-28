import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { HOST_OWNED_SETTING_UPDATE_SHAPE } from '../../../shared/settings/host-owned-settings'
import {
  isLocalWebhookBindAddress,
  localWebhookBaseUrl,
  localWebhookConfig,
  localWebhookPublicUrlProblem
} from '../../../shared/webhooks/local-webhook-settings'
import { installLocalWebhooks, type LocalWebhooks } from './local-webhooks-install'
import { listenOnLoopback } from './local-webhook.test-fixture'

const freePort = async () => {
  const probe = createServer()
  const port = await listenOnLoopback(probe)
  await new Promise((resolve) => probe.close(resolve))
  return port
}

describe('local webhook settings', () => {
  it('is off by default', () => {
    expect(localWebhookConfig({})).toBeNull()
    expect(localWebhookConfig({ localWebhooksEnabled: false })).toBeNull()
  })

  it('shows the local http URL without a Public URL, and the Public URL with one', () => {
    expect(localWebhookConfig({ localWebhooksEnabled: true })).toEqual({
      bindAddress: '127.0.0.1',
      port: 6790,
      baseUrl: 'http://127.0.0.1:6790'
    })
    expect(localWebhookBaseUrl('100.64.0.7', 7000, '')).toBe('http://100.64.0.7:7000')
    expect(localWebhookBaseUrl('fd00::1', 7000, '')).toBe('http://[fd00::1]:7000')
    expect(localWebhookBaseUrl('127.0.0.1', 7000, 'https://hooks.example.net/')).toBe(
      'https://hooks.example.net'
    )
    // An unusable Public URL is never shown.
    expect(localWebhookBaseUrl('127.0.0.1', 7000, 'ftp://x')).toBe('http://127.0.0.1:7000')
    // As a sender parses it: a trailing backslash is a slash, and a path prefix stays.
    expect(localWebhookBaseUrl('127.0.0.1', 7000, 'https://hooks.example.net/webhooks\\')).toBe(
      'https://hooks.example.net/webhooks'
    )
  })

  it('checks the Public URL and the listen address', () => {
    expect(localWebhookPublicUrlProblem('')).toBeNull()
    expect(localWebhookPublicUrlProblem('https://a.example/x')).toBeNull()
    expect(localWebhookPublicUrlProblem('https://a.example/?q=1')).not.toBeNull()
    expect(localWebhookPublicUrlProblem('https://a.example/?')).not.toBeNull()
    expect(localWebhookPublicUrlProblem('https://a.example/#')).not.toBeNull()
    expect(localWebhookPublicUrlProblem('hooks.example.net')).not.toBeNull()
    expect(isLocalWebhookBindAddress('100.64.0.1')).toBe(true)
    expect(isLocalWebhookBindAddress('::1')).toBe(true)
    expect(isLocalWebhookBindAddress('300.1.1.1')).toBe(false)
    expect(isLocalWebhookBindAddress('example.net')).toBe(false)
    expect(isLocalWebhookBindAddress('::\t1')).toBe(false)
  })

  it('takes only an IP literal or nothing as the listen address, so routing matches the listener', () => {
    const bind = HOST_OWNED_SETTING_UPDATE_SHAPE.localWebhooksBindAddress
    expect(bind.safeParse('localhost').success).toBe(false)
    expect(bind.safeParse('').success).toBe(true)
    expect(bind.safeParse('::1').success).toBe(true)
    // A name saved before this check still listens, and routes, on the default.
    expect(
      localWebhookConfig({ localWebhooksEnabled: true, localWebhooksBindAddress: 'localhost' })
    ).toMatchObject({ bindAddress: '127.0.0.1' })
  })
})

describe('installLocalWebhooks', () => {
  let dir: string | undefined
  let installed: LocalWebhooks | undefined
  let busy: Server | undefined
  afterEach(() => {
    vi.restoreAllMocks()
    installed?.stop()
    busy?.close()
    busy?.closeAllConnections()
    busy = undefined
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('listens and replaces the cloud routes only while Settings turn it on', async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-webhooks-install-'))
    const port = await freePort()
    let settings: Partial<GlobalSettings> = {}
    const listeners: ((updates: Partial<GlobalSettings>) => void)[] = []
    let modeChanges = 0
    installed = installLocalWebhooks({
      userDataPath: dir,
      settings: () => settings,
      onSettingsChanged: (listener) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
      automations: () => [],
      bots: () => [],
      modeChanged: () => modeChanges++
    })
    const change = (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      listeners.forEach((listener) => listener(updates))
    }
    const reach = () =>
      fetch(`http://127.0.0.1:${port}/hooks/wh_AAAAAAAAAAAAAAAA`, { method: 'POST' }).then(
        (answer) => answer.status,
        () => 'closed'
      )

    expect(installed.routes()).toBeNull()
    expect(await reach()).toBe('closed')

    change({ localWebhooksEnabled: true, localWebhooksPort: port })
    expect(installed.routes()).not.toBeNull()
    expect(modeChanges).toBe(1)
    await expect.poll(reach).toBe(401)

    change({ localWebhooksEnabled: false })
    expect(installed.routes()).toBeNull()
    expect(modeChanges).toBe(2)
    await expect.poll(reach).toBe('closed')
  })

  it('listens once a busy port frees up', async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-webhooks-install-'))
    busy = createServer()
    const port = await listenOnLoopback(busy)
    const occupied = busy
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installed = installLocalWebhooks({
      userDataPath: dir,
      settings: () => ({ localWebhooksEnabled: true, localWebhooksPort: port }),
      onSettingsChanged: () => () => {},
      automations: () => [],
      bots: () => [],
      modeChanged: () => {},
      bindRetryMs: 50
    })
    const reach = () =>
      fetch(`http://127.0.0.1:${port}/hooks/wh_AAAAAAAAAAAAAAAA`, { method: 'POST' }).then(
        (answer) => answer.status,
        () => 'closed'
      )
    // The first bind fails on the busy port before the port frees up.
    await expect.poll(() => warn.mock.calls.length).toBeGreaterThan(0)
    await new Promise((resolve) => {
      occupied.close(resolve)
      occupied.closeAllConnections()
    })
    busy = undefined
    await expect.poll(reach).toBe(401)
  })

  it('tries the queued calls again after a failed read, and never after stop', async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-webhooks-install-'))
    // A folder where the store's file goes: every read of it fails.
    mkdirSync(join(dir, 'local-webhooks', 'hooks.json'), { recursive: true })
    // The listener's port is taken, so this test serves nothing.
    busy = createServer()
    const port = await listenOnLoopback(busy)
    // Stopped from inside the second failed read, before it asks for another pass.
    let failedReads = 0
    vi.spyOn(console, 'warn').mockImplementation((text) => {
      if (String(text).includes('could not be read') && ++failedReads === 2) {
        installed?.stop()
      }
    })
    installed = installLocalWebhooks({
      userDataPath: dir,
      settings: () => ({ localWebhooksEnabled: true, localWebhooksPort: port }),
      onSettingsChanged: () => () => {},
      automations: () => [],
      bots: () => [],
      modeChanged: () => {},
      redeliverMs: 10
    })
    installed.attach(() => true)
    await expect.poll(() => failedReads).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(failedReads).toBe(2)
  })
})
