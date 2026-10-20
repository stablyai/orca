import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '', tabs: new Set<number>() }))

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => mocks.userData },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn() },
  webFrameMain: { fromId: vi.fn() }
}))
vi.mock('../browser-extension-tab-model', () => ({
  resolveBrowserExtensionTab: (id: number) =>
    mocks.tabs.has(id) ? { contents: { id, session: currentSession } } : null
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-dnr-api-'))
let currentSession: Electron.Session | null = null

const registry = await import('../browser-extension-namespace-registry')
const { registerDeclarativeNetRequestNamespace } = await import('./declarative-net-request')
const { attachBrowserExtensionDnr, getDnrSessionRuntime } =
  await import('../browser-extension-dnr-session')
const { browserExtensionDnrRequestDecider: decider } =
  await import('../browser-extension-dnr-requests')
const { DNR_API_CONSTANTS } = await import('../browser-extension-dnr-limits')
const { BROWSER_EXTENSION_API_SURFACE } =
  await import('../../../../preload/browser-extension-api-surface')

registerDeclarativeNetRequestNamespace()

const ID = 'd'.repeat(32)
const PROFILE = 'profile-api'
const TAB = 9
mocks.tabs.add(TAB)

const block = (id: number, urlFilter: string) => ({
  id,
  condition: { urlFilter },
  action: { type: 'block' }
})

const extensionDir = mkdtempSync(join(tmpdir(), 'orca-dnr-api-extension-'))
writeFileSync(join(extensionDir, 'a.json'), JSON.stringify([block(1, '||a.example^')]))
writeFileSync(
  join(extensionDir, 'b.json'),
  JSON.stringify([block(1, '||b.example^'), block(2, '||b2.example^')])
)

function extension(version = '1', permissions: string[] = []): Electron.Extension {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the DNR code reads only id, version, path and manifest.
  return {
    id: ID,
    name: 'Blocker',
    version,
    path: extensionDir,
    url: '',
    manifest: {
      permissions: ['declarativeNetRequest', ...permissions],
      host_permissions: ['<all_urls>'],
      declarative_net_request: {
        rule_resources: [
          { id: 'a', enabled: true, path: 'a.json' },
          { id: 'b', enabled: false, path: 'b.json' }
        ]
      }
    }
  } as unknown as Electron.Extension
}

/** A fresh session loading the extension, as at the next launch (the store persists). */
async function launch(ext = extension()) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime touches only these session members.
  const session = {
    extensions: { on: vi.fn(), getAllExtensions: () => [ext] },
    webRequest: { onHeadersReceived: vi.fn() }
  } as unknown as Electron.Session
  currentSession = session
  attachBrowserExtensionDnr(session, PROFILE, [])
  await getDnrSessionRuntime(session)?.whenLoaded()
  const caller = { extension: ext, session, browserProfileId: PROFILE }
  const call = (method: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve().then(() =>
      registry
        .getBrowserExtensionNamespace('declarativeNetRequest')
        ?.methods[method]?.invoke(caller, args)
    )
  const blocks = (url: string): boolean => {
    const answer = decider.beforeRequest(session, {
      id: 1,
      url,
      method: 'GET',
      resourceType: 'script',
      referrer: '',
      timestamp: 0,
      webContentsId: TAB,
      initiatorOrigin: 'https://site.example',
      uploadData: []
    })
    return answer !== null && 'cancel' in answer && answer.cancel === true
  }
  return { call, blocks, session }
}

describe('chrome.declarativeNetRequest', () => {
  it("gives extensions main's limits as the API constants", () => {
    expect(BROWSER_EXTENSION_API_SURFACE.declarativeNetRequest?.constants).toEqual(
      DNR_API_CONSTANTS
    )
  })

  it('replaces dynamic rules all or nothing and keeps them for the next launch', async () => {
    const { call, blocks } = await launch()
    await call('updateDynamicRules', { addRules: [block(1, '||x.example^'), block(2, 'y')] })
    await call('updateDynamicRules', { removeRuleIds: [2], addRules: [block(3, '||z.example^')] })
    expect(blocks('https://x.example/1.js')).toBe(true)
    await expect(call('getDynamicRules', { ruleIds: [3] })).resolves.toMatchObject([{ id: 3 }])
    await expect(
      call('updateDynamicRules', { addRules: [block(1, '||again.example^')] })
    ).rejects.toThrow('Rule with id 1 does not have a unique ID.')
    await expect(
      call('updateDynamicRules', { addRules: [{ id: 4, condition: {}, action: {} }] })
    ).rejects.toThrow(/couldn't be parsed/)
    const next = await launch()
    await expect(next.call('getDynamicRules')).resolves.toMatchObject([{ id: 1 }, { id: 3 }])
    expect(next.blocks('https://z.example/1.js')).toBe(true)
    await next.call('updateDynamicRules', { removeRuleIds: [1, 3] })
  })

  it("enforces Chrome's dynamic and session rule limits", async () => {
    const { call } = await launch()
    const redirects = Array.from({ length: 5001 }, (_, index) => ({
      id: index + 1,
      condition: { urlFilter: `r${index}` },
      action: { type: 'redirect', redirect: { url: 'https://safe.example/' } }
    }))
    await expect(call('updateDynamicRules', { addRules: redirects })).rejects.toThrow(
      'Dynamic unsafe rule count exceeded.'
    )
    const blocks = Array.from({ length: 5001 }, (_, index) => block(index + 1, `s${index}`))
    await expect(call('updateSessionRules', { addRules: blocks })).rejects.toThrow(
      'Session rule count exceeded.'
    )
    await expect(call('getSessionRules')).resolves.toEqual([])
  })

  it('switches static rulesets, and an update brings back the manifest choice', async () => {
    const { call, blocks } = await launch()
    await expect(call('getEnabledRulesets')).resolves.toEqual(['a'])
    await call('updateEnabledRulesets', { enableRulesetIds: ['b'], disableRulesetIds: ['a'] })
    expect(blocks('https://b.example/x.js')).toBe(true)
    expect(blocks('https://a.example/x.js')).toBe(false)
    await expect(call('updateEnabledRulesets', { enableRulesetIds: ['zzz'] })).rejects.toThrow(
      'Invalid ruleset id: zzz.'
    )
    await expect(call('getAvailableStaticRuleCount')).resolves.toBe(330_000 - 2)
    await expect((await launch()).call('getEnabledRulesets')).resolves.toEqual(['b'])
    await expect((await launch(extension('2'))).call('getEnabledRulesets')).resolves.toEqual(['a'])
  })

  it('disables single static rules', async () => {
    const { call, blocks } = await launch(extension('3'))
    await call('updateStaticRules', { rulesetId: 'a', disableRuleIds: [1] })
    expect(blocks('https://a.example/x.js')).toBe(false)
    await expect(call('getDisabledRuleIds', { rulesetId: 'a' })).resolves.toEqual([1])
    await expect(
      call('updateStaticRules', {
        rulesetId: 'b',
        disableRuleIds: Array.from({ length: 5000 }, (_, index) => index + 2)
      })
    ).rejects.toThrow('The number of disabled static rules exceeds the disabled rule count limit.')
    await call('updateStaticRules', { rulesetId: 'a', enableRuleIds: [1] })
    expect(blocks('https://a.example/x.js')).toBe(true)
  })

  it('checks regexes and tests a request against its own rules', async () => {
    const { call } = await launch(extension('4'))
    await expect(call('isRegexSupported', { regex: '^https://a\\.example/' })).resolves.toEqual({
      isSupported: true
    })
    await expect(call('isRegexSupported', { regex: '(' })).resolves.toEqual({
      isSupported: false,
      reason: 'syntaxError'
    })
    await expect(
      call('testMatchOutcome', { url: 'https://a.example/x.js', type: 'script', tabId: TAB })
    ).resolves.toEqual({ matchedRules: [{ ruleId: 1, rulesetId: 'a' }] })
    await expect(call('testMatchOutcome', { url: 'nope', type: 'script' })).rejects.toThrow(
      'Invalid test request URL.'
    )
  })

  it('reports matched rules only with feedback (or activeTab) access', async () => {
    const plain = await launch(extension('5'))
    await expect(plain.call('getMatchedRules')).rejects.toThrow(
      /declarativeNetRequestFeedback permission or have activeTab/
    )
    await expect(
      plain.call('setExtensionActionOptions', { tabUpdate: { tabId: TAB, increment: 1 } })
    ).rejects.toThrow('Cannot increment action count unless displaying action count as badge text.')
    const feedback = await launch(extension('5', ['declarativeNetRequestFeedback']))
    expect(feedback.blocks('https://a.example/x.js')).toBe(true)
    await expect(feedback.call('getMatchedRules', { tabId: TAB })).resolves.toMatchObject({
      rulesInfo: [{ rule: { ruleId: 1, rulesetId: 'a' }, tabId: TAB }]
    })
    await expect(feedback.call('getMatchedRules', { tabId: 404 })).rejects.toThrow(
      'No tab with id: 404.'
    )
  })
})
