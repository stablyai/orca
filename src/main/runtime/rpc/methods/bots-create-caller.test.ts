import { afterEach, describe, expect, it } from 'vitest'
import { botCreateCaller } from './bots-caller-gates'
import { isCliBotCreateAllowed, setCliBotCreateAllowed } from '../../../bots/bot-cli-create'
import { sanitizeRendererSettingsUpdate } from '../../../ipc/settings/renderer-settings-update'
import { SettingsUpdate } from '../../../../shared/rpc-contract/client-ui/client-settings-params'
import { serveOptionArgs } from '../../../../shared/remote-runtime/serve-supervisor/orcad-serve-argv'
import { getServeOptions } from '../../../startup/serve-launch/serve-options'
import { parseArgs } from '../../../orcad/serve-startup/orcad-command-arguments'

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
const plainAndTemplate = {
  name: 'Triage',
  agent: 'codex',
  seed: { purpose: 'Triage bugs.', templateId: 'pr-review' },
  fromTemplate: { id: 'pr-review', skills: ['pr-review-checklist'] },
  handOff: [{ id: 'w1', name: 'orca' }]
}

describe('bots.create caller gate', () => {
  afterEach(() => setCliBotCreateAllowed(false))

  it('refuses the local CLI while neither serve flag nor desktop setting enables it', () => {
    expect(isCliBotCreateAllowed()).toBe(false)
    expect(isCliBotCreateAllowed({ allowCliBotCreate: false })).toBe(false)
    expect(() => botCreateCaller(localCli, {})).toThrow(/bot create --offer/)
    expect(() => botCreateCaller(localCli, {}, false)).toThrow(/bot create --offer/)
  })

  it('lets the local CLI create a plain or template bot when the serve flag or desktop setting is on', () => {
    setCliBotCreateAllowed(true)
    expect(isCliBotCreateAllowed({ allowCliBotCreate: false })).toBe(true)
    expect(() => botCreateCaller(localCli, plainAndTemplate)).not.toThrow()

    setCliBotCreateAllowed(false)
    const desktopAllowed = isCliBotCreateAllowed({ allowCliBotCreate: true })
    expect(desktopAllowed).toBe(true)
    expect(() => botCreateCaller(localCli, plainAndTemplate, desktopAllowed)).not.toThrow()
  })

  it('never lets a CLI accept a card, share link, or owner-only override even when allowed', () => {
    expect(() => botCreateCaller(localCli, offer, true)).toThrow(/bot create --offer/)
    expect(() => botCreateCaller(localCli, share, true)).toThrow(/bot create --offer/)
    expect(() =>
      botCreateCaller(localCli, { name: 'Triage', permissionMode: 'bypassPermissions' }, true)
    ).toThrow(/bot create --offer/)
    expect(() =>
      botCreateCaller(localCli, { name: 'Triage', launch: { model: 'gpt-5' } }, true)
    ).toThrow(/bot create --offer/)
    expect(() => botCreateCaller(localCli, { name: 'Triage', takingOver: true }, true)).toThrow(
      /bot create --offer/
    )
    expect(() =>
      botCreateCaller(
        localCli,
        { name: 'Triage', importFrom: { app: 'openclaw', name: 'A' } },
        true
      )
    ).toThrow(/bot create --offer/)
  })

  it('never lets a paired CLI create, even when allowed', () => {
    expect(() => botCreateCaller(pairedCli, plainAndTemplate, true)).toThrow(/bot create --offer/)
  })

  it("leaves the owner's window and phone as they were", () => {
    for (const context of [desktop, phone]) {
      expect(() => botCreateCaller(context, {}, false)).not.toThrow()
      expect(() => botCreateCaller(context, offer, false)).not.toThrow()
      expect(() =>
        botCreateCaller(context, { name: 'Triage', permissionMode: 'bypassPermissions' }, false)
      ).not.toThrow()
    }
  })

  it('prevents RPC settings.update from enabling allowCliBotCreate and sanitizes desktop IPC values', () => {
    expect(SettingsUpdate.safeParse({ allowCliBotCreate: true }).success).toBe(false)
    expect(sanitizeRendererSettingsUpdate({ allowCliBotCreate: true })).toEqual({
      allowCliBotCreate: true
    })
    expect(
      sanitizeRendererSettingsUpdate({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test runtime rejection of non-boolean IPC payload.
        allowCliBotCreate: 'yes' as unknown as boolean
      })
    ).toEqual({})
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
    expect(() => botCreateCaller(localCli, {})).not.toThrow()
    expect(parseArgs(serveOptionArgs({ allowCliBotCreate: true }, '--')).allowCliBotCreate).toBe(
      true
    )
  })
})
