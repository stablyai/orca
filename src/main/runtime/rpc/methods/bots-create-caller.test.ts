import { afterEach, describe, expect, it } from 'vitest'
import { botCreateCaller } from './bots-caller-gates'
import { setCliBotCreateAllowed } from '../../../bots/bot-cli-create'
import { serveOptionArgs } from '../../../../shared/remote-runtime/serve-supervisor/orcad-serve-argv'
import { getServeOptions } from '../../../startup/serve-launch/serve-options'
import { parseArgs } from '../../../orcad/serve-startup/orcad-command-arguments'

const botCreateCallerAllowedForLocalCli = () => {
  try {
    botCreateCaller(localCli, {})
    return true
  } catch {
    return false
  }
}
const localCli = { caller: { kind: 'local-cli' } as const }
const pairedCli = {
  caller: { kind: 'paired-device', deviceId: 'd1', agent: true } as const
}
const phone = { caller: { kind: 'paired-device', deviceId: 'd1' } as const }
const desktop = { caller: { kind: 'desktop' } as const }
const offer = { fromOffer: { botId: 'b', offerId: 'o' } }
const share = {
  fromShare: { reviewId: '00000000-0000-4000-8000-000000000000', toolIds: [] }
}

describe('bots.create caller gate', () => {
  afterEach(() => setCliBotCreateAllowed(false))

  it('refuses the local CLI while the host was not served with --allow-cli-bot-create', () => {
    expect(() => botCreateCaller(localCli, {})).toThrow(/bot create --offer/)
    expect(() => botCreateCaller(localCli, {}, false)).toThrow(/bot create --offer/)
  })

  it('lets the local CLI create a plain bot once the host allows it', () => {
    setCliBotCreateAllowed(true)
    expect(() => botCreateCaller(localCli, {})).not.toThrow()
  })

  it('never lets a CLI accept a card or a share link, even when allowed', () => {
    expect(() => botCreateCaller(localCli, offer, true)).toThrow()
    expect(() => botCreateCaller(localCli, share, true)).toThrow()
  })

  it('never lets a paired CLI create, even when allowed', () => {
    expect(() => botCreateCaller(pairedCli, {}, true)).toThrow()
  })

  it("leaves the owner's window and phone as they were", () => {
    for (const context of [desktop, phone]) {
      expect(() => botCreateCaller(context, {}, false)).not.toThrow()
      expect(() => botCreateCaller(context, offer, false)).not.toThrow()
    }
  })
})

describe('--allow-cli-bot-create reaches both serve runtimes', () => {
  afterEach(() => setCliBotCreateAllowed(false))

  it('is off unless passed', () => {
    expect(serveOptionArgs({}, '--serve-')).not.toContain('--serve-allow-cli-bot-create')
    expect(getServeOptions(['--serve']).allowCliBotCreate).toBe(false)
    expect(parseArgs([]).allowCliBotCreate).toBeUndefined()
  })

  it('survives the CLI to Electron and orcad argv boundary', () => {
    const electron = serveOptionArgs({ allowCliBotCreate: true }, '--serve-')
    expect(getServeOptions(['--serve', ...electron]).allowCliBotCreate).toBe(true)
    expect(botCreateCallerAllowedForLocalCli()).toBe(true)
    expect(parseArgs(serveOptionArgs({ allowCliBotCreate: true }, '--')).allowCliBotCreate).toBe(
      true
    )
  })
})
