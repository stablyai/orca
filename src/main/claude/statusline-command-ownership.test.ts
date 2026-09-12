import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/synthetic/unused' } }))
import {
  getStatusLineSlotState,
  applyManagedStatusLine,
  removeManagedStatusLine
} from './hook-settings'
import { statusLineCommandSha256 } from './statusline-install-marker'
import runtimeFixtures from './statusline-command-fixtures.json'
import legacyFixtures from './statusline-legacy-fixtures.json'

const slot = (command: string) => ({ type: 'command', command })
const fixtures = [...runtimeFixtures, ...legacyFixtures]

describe('complete statusLine ownership', () => {
  it.each(fixtures)('admits complete producer $ref / $sha256', ({ command, sha256 }) => {
    expect(statusLineCommandSha256(command)).toBe(sha256)
    expect(getStatusLineSlotState({ statusLine: slot(command) })).toBe('managed')
    expect(removeManagedStatusLine({ statusLine: slot(command), other: 1 }).config).toEqual({
      other: 1
    })
  })

  it.each(fixtures)('rejects edits around producer $sha256', ({ command }) => {
    const mutations = [
      `${command}; printf user`,
      `${command} | render`,
      `${command} > user`,
      `${command} # user`,
      `echo ${command}`,
      `${command} `,
      command.replace('claude-statusline', 'other-statusline'),
      command.replace('/bin/sh', '/bin/bash'),
      command.replace('powershell.exe', 'pwsh.exe'),
      command.replace('-NoProfile', '-NonInteractive'),
      command.replace('.cmd', '.ps1')
    ].filter((value) => value !== command)
    for (const edited of mutations) {
      expect(
        getStatusLineSlotState({ statusLine: slot(edited) }, 'claude-statusline.sh', {
          present: true,
          commandSha256: statusLineCommandSha256(command)
        })
      ).toBe('user')
    }
  })

  it.each([
    null,
    '',
    false,
    0,
    [],
    {},
    { type: 'custom', command: 'x' },
    slot(''),
    { command: 'x' },
    { type: 'command', command: 1 },
    slot("printf 'agent-hooks/claude-statusline.ps1'")
  ])('preserves occupied explicit value %j', (statusLine) => {
    const config = { statusLine, other: { keep: true } }
    expect(getStatusLineSlotState(config)).toBe('user')
    expect(applyManagedStatusLine(config, 'new')).toBe(config)
    expect(removeManagedStatusLine(config)).toEqual({ config, changed: false })
  })

  it.each(['padding', 'args', 'timeout', 'unknown'])(
    'extra field %s protects the entire slot',
    (key) => {
      const command = runtimeFixtures[0].command
      const config = { statusLine: { ...slot(command), [key]: 0 } }
      expect(
        getStatusLineSlotState(config, 'claude-statusline.cmd', {
          present: true,
          commandSha256: statusLineCommandSha256(command)
        })
      ).toBe('user')
      expect(removeManagedStatusLine(config).config).toEqual(config)
    }
  )

  it('admits only matching fingerprints, even beyond template ceiling', () => {
    const command = 'retired generated output'.repeat(1000)
    const marker = { present: true, commandSha256: statusLineCommandSha256(command) }
    expect(getStatusLineSlotState({ statusLine: slot(command) }, undefined, marker)).toBe('managed')
    expect(getStatusLineSlotState({ statusLine: slot(`${command} `) }, undefined, marker)).toBe(
      'user'
    )
    expect(getStatusLineSlotState({ statusLine: slot(command) })).toBe('user')
  })

  it('requires canonical encoding and full payload equality', () => {
    const command = legacyFixtures.find((f) => f.command.includes('-EncodedCommand'))!.command
    const [prefix, encoded] = command.split(' -EncodedCommand ')
    const payload = Buffer.from(encoded, 'base64').toString('utf16le')
    for (const bad of [
      `${encoded}=`,
      `${encoded}\n`,
      Buffer.from(`${payload}; Write-Output user`, 'utf16le').toString('base64'),
      Buffer.from(payload.replace('& ', '& echo '), 'utf16le').toString('base64')
    ]) {
      expect(getStatusLineSlotState({ statusLine: slot(`${prefix} -EncodedCommand ${bad}`) })).toBe(
        'user'
      )
    }
    expect(
      getStatusLineSlotState({ statusLine: slot(command.replace('C:/Windows', 'powershell')) })
    ).toBe('user')
  })

  it('bounds template admission at exact 16383/16384/16385 code units', () => {
    const base = legacyFixtures.find((f) => f.command.length === 160)!.command
    const command = base.replaceAll(
      'Users/old',
      `Users/old${'x'.repeat((16384 - base.length) / 2)}`
    )
    const oddBase = legacyFixtures.find((f) => f.command.length === 195)!.command
    for (const size of [16383, 16385]) {
      const odd = oddBase.replaceAll(
        'Users/old',
        `Users/old${'x'.repeat((size - oddBase.length) / 2)}`
      )
      expect(odd.length).toBe(size)
      expect(getStatusLineSlotState({ statusLine: slot(odd) })).toBe(
        size < 16384 ? 'managed' : 'user'
      )
    }
    expect(command.length).toBe(16384)
    expect(getStatusLineSlotState({ statusLine: slot(command) })).toBe('managed')
    for (const edited of [command.slice(0, -1), `${command} `]) {
      expect([16383, 16385]).toContain(edited.length)
      expect(getStatusLineSlotState({ statusLine: slot(edited) })).toBe('user')
    }
    const over = base.replaceAll('Users/old', `Users/old${'x'.repeat((16386 - base.length) / 2)}`)
    expect(over.length).toBe(16386)
    expect(getStatusLineSlotState({ statusLine: slot(over) })).toBe('user')
  })
})

it.each(legacyFixtures)(
  'validates absolute paths and every repeated token: $sha256',
  ({ command }) => {
    for (const edited of [
      command.replace('claude-statusline.', 'claude-statusline-extra.'),
      command.replaceAll('/.orca/', '/elsewhere/'),
      command.replaceAll('C:/Users', 'C:Users'),
      command.replaceAll('/synthetic/', 'relative/'),
      command.replaceAll('C:/Users', '//server/Users')
    ]) {
      if (edited !== command) {
        expect(getStatusLineSlotState({ statusLine: slot(edited) })).toBe('user')
      }
    }
  }
)

it('requires the fixed encoded executable, switches, path selection and encoding', () => {
  const command = legacyFixtures.find((f) => f.command.includes('-EncodedCommand'))!.command
  const [prefix, encoded] = command.split(' -EncodedCommand ')
  const payload = Buffer.from(encoded, 'base64').toString('utf16le')
  const encode = (s: string) => Buffer.from(s, 'utf16le').toString('base64')
  const mutations = [
    command.replace('C:/Windows', 'C:/Windows Space'),
    command.replace('C:/Windows', 'C:Windows'),
    command.replace('powershell.exe', 'PowerShell.exe'),
    command.replace(' -NoProfile', ''),
    command.replace('-ExecutionPolicy Bypass', '-ExecutionPolicy Unrestricted'),
    `${prefix} -EncodedCommand ${encode(payload.replaceAll("D:\\Users\\old '' ; home", 'relative'))}`,
    `${prefix} -EncodedCommand ${encode(payload.replaceAll("D:\\Users\\old '' ; home", 'D:\\Users\\safe'))}`,
    `${prefix} -EncodedCommand ${Buffer.concat([Buffer.from(payload, 'utf16le'), Buffer.from([0])]).toString('base64')}`,
    `${prefix} -EncodedCommand ${encode(payload.replaceAll('claude-statusline.cmd', 'claude-statusline.ps1'))}`
  ]
  for (const edited of mutations) {
    expect(getStatusLineSlotState({ statusLine: slot(edited) })).toBe('user')
  }
  expect(
    getStatusLineSlotState({ statusLine: slot(command.replace('C:/Windows', 'D:/WinRoot')) })
  ).toBe('managed')
})
