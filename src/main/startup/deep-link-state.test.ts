import { describe, expect, it, vi } from 'vitest'
import { DeepLinkState } from './deep-link-state'

const BOT_URL = 'orca://bot/bot_1?conversation=slack%3AT1%3AC1%3A1700.1'
const BOT_LINK = {
  botId: 'bot_1',
  conversation: { source: 'slack', externalId: 'T1:C1:1700.1' }
}

describe('DeepLinkState', () => {
  it('queues a startup share until the renderer consumes it once', () => {
    const state = new DeepLinkState()

    expect(state.capture(['orca', 'https://app.orca.dev/skills/share/share_startup'])).toBe(true)
    expect(state.consumeSkillShare()).toBe('share_startup')
    expect(state.consumeSkillShare()).toBeNull()
  })

  it('publishes a later second-instance intent and keeps it for renderer recovery', () => {
    const state = new DeepLinkState()
    const publish = vi.fn()

    state.capture(['orca', 'https://app.orca.dev/skills/share/share_first'])
    expect(state.capture(['orca', 'orca://skills/share/share_second'], publish)).toBe(true)

    expect(publish).toHaveBeenCalledWith({
      kind: 'skill-share',
      shareId: 'share_second'
    })
    expect(state.consumeSkillShare()).toBe('share_second')
  })

  it('ignores untrusted URLs without replacing a pending intent', () => {
    const state = new DeepLinkState()
    state.capture(['orca', 'https://app.orca.dev/skills/share/share_safe'])

    expect(state.capture(['orca', 'https://attacker.test/skills/share/share_bad'])).toBe(false)
    expect(state.consumeSkillShare()).toBe('share_safe')
  })

  it('holds a bot share link apart from skill shares, from the app scheme or the share page', () => {
    const state = new DeepLinkState()
    const publish = vi.fn()

    expect(state.capture(['orca', 'orca://bots/share/k7Qm1xR9vTb4'], publish)).toBe(true)
    expect(publish).toHaveBeenCalledWith({ kind: 'bot-share', shareId: 'k7Qm1xR9vTb4' })
    expect(state.consumeSkillShare()).toBeNull()
    expect(state.consumeBotShare()).toBe('k7Qm1xR9vTb4')

    expect(state.capture(['orca', 'https://app.orca.dev/bots/share/other'])).toBe(true)
    expect(state.drainArguments()).toEqual(['orca://bots/share/other'])
    expect(state.capture(['orca', 'https://attacker.test/bots/share/bad'])).toBe(false)
  })

  // macOS delivers the URL through open-url; Windows and Linux put it in the second instance's argv.
  it.each([
    ['macOS open-url', [BOT_URL]],
    [
      'Windows argv',
      ['C:\\Program Files\\Orca\\Orca.exe', '--allow-file-access-from-files', BOT_URL]
    ],
    ['Linux argv', ['/opt/Orca/orca', '--no-sandbox', BOT_URL]]
  ])('routes a bot link from %s', (_platform, argv) => {
    const state = new DeepLinkState()
    const publish = vi.fn()

    expect(state.accepts(BOT_URL)).toBe(true)
    expect(state.capture(argv, publish)).toBe(true)
    expect(publish).toHaveBeenCalledWith({ kind: 'bot', link: BOT_LINK })
    expect(state.consumeBotLink()).toEqual(BOT_LINK)
    expect(state.consumeBotLink()).toBeNull()
  })

  it('drops repeated and bursting skill shares', () => {
    let now = 0
    const state = new DeepLinkState(() => now)
    const publish = vi.fn()
    state.capture(['orca://skills/share/abc'], publish)
    state.capture(['orca://skills/share/abc'], publish)
    expect(publish).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 10; index += 1) {
      state.capture([`orca://skills/share/s${index}`], publish)
    }
    expect(publish).toHaveBeenCalledTimes(5)
    now = 5_000
    state.capture(['orca://skills/share/abc'], publish)
    expect(publish).toHaveBeenCalledTimes(6)
  })

  it('keeps skill share routing beside bot links', () => {
    const state = new DeepLinkState()

    expect(state.accepts('orca://skills/share/abc')).toBe(true)
    expect(state.capture(['orca', 'orca://skills/share/abc'])).toBe(true)
    expect(state.consumeBotLink()).toBeNull()
    expect(state.consumeSkillShare()).toBe('abc')
  })

  it('hands every pending link to another instance, which routes each of them', () => {
    const state = new DeepLinkState()
    state.capture(['orca://skills/share/abc'])
    state.capture([BOT_URL])
    state.capture([`orca://linear/link?t=${'L'.repeat(43)}`])
    state.capture([`orca://github/link?t=${'G'.repeat(43)}`])

    const desktop = new DeepLinkState()
    expect(desktop.capture(state.drainArguments())).toBe(true)

    expect(desktop.consumeSkillShare()).toBe('abc')
    expect(desktop.consumeBotLink()).toEqual(BOT_LINK)
    expect([desktop.consumeConnectorLink(), desktop.consumeConnectorLink()]).toEqual([
      { source: 'linear', token: 'L'.repeat(43) },
      { source: 'github', token: 'G'.repeat(43) }
    ])
    expect(state.drainArguments()).toEqual([])
  })

  it('keeps service links apart from bot links, the latest of each service', () => {
    const state = new DeepLinkState()
    const publish = vi.fn()

    const url = `orca://linear/link?t=${'L'.repeat(43)}`
    expect(state.accepts(url)).toBe(true)
    expect(state.capture([url], publish)).toBe(true)
    expect(publish).toHaveBeenCalledWith({
      kind: 'connector-link',
      link: { source: 'linear', token: 'L'.repeat(43) }
    })
    // A GitHub link never replaces the Linear one; a newer GitHub link replaces the older.
    state.capture([`orca://github/link?t=${'A'.repeat(43)}`])
    state.capture([`orca://github/link?t=${'G'.repeat(43)}`])
    expect(state.consumeBotLink()).toBeNull()
    expect(state.consumeConnectorLink()).toEqual({ source: 'linear', token: 'L'.repeat(43) })
    expect(state.consumeConnectorLink()).toEqual({ source: 'github', token: 'G'.repeat(43) })
    expect(state.consumeConnectorLink()).toBeNull()
  })

  it('holds an access request link once, hands it to another instance, and drops it with bots off', () => {
    const url = `orca://bot/access-request?t=${'b'.repeat(43)}`
    const state = new DeepLinkState()
    expect(state.accepts(url)).toBe(true)
    state.capture(['orca', url])
    expect(state.consumeBotLink()).toBeNull()
    expect(state.consumeAccessRequest()).toEqual({ token: 'b'.repeat(43) })
    expect(state.consumeAccessRequest()).toBeNull()

    state.capture(['orca', url])
    expect(state.drainArguments()).toEqual([url])

    state.capture(['orca', url])
    state.discardConnectorLinks()
    expect(state.consumeAccessRequest()).toBeNull()
  })
})
