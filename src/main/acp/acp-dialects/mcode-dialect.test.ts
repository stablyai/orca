import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import { MCODE_DIALECT, normalizeMcodeConfigOptions } from './mcode-dialect'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import { acpSelectChoices } from '../options/acp-select-choices'
import { writeAcpSessionOption } from '../options/acp-session-option-write'
import { applyAcpMessageOptions } from '../turns/acp-message-execution-options'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

const FLASH = 'm:minimax:MiniMax-M3.1-Flash:v:thinking'
const FLASH_OFF = FLASH.slice(0, -'thinking'.length)
const M3_THINKING = 'm:minimax:MiniMax-M3:v:thinking'
const M3_OFF = 'm:minimax:MiniMax-M3:v:'
const LEGACY_M3 = 'm:custom_provider%3Aminimax-legacy:MiniMax-M3:v:thinking'
const LEGACY_M27 = 'm:custom_provider%3Aminimax-legacy:MiniMax-M2.7:v:thinking'

/** The rows mcode lists: every `variants` key of a model, and one row for a model without them. */
const rows: [string, string][] = [
  [M3_OFF, 'M3'],
  [M3_THINKING, 'M3 · thinking'],
  [FLASH_OFF, 'M3.1-Flash'],
  [FLASH, 'M3.1-Flash · thinking'],
  [LEGACY_M3, 'M3 · thinking'],
  [LEGACY_M27, 'M2.7 · thinking']
]

const modelSelect = (currentValue: string): SelectOption => ({
  type: 'select',
  id: 'model',
  name: 'Model',
  category: 'model',
  currentValue,
  options: rows.map(([value, name]) => ({ value, name }))
})

const effortMenu: SelectOption = {
  type: 'select',
  id: 'thinkingEffort',
  name: 'Thinking effort',
  category: 'thought_level',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Default' },
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' }
  ]
}

const select = (options: SessionConfigOption[], id: string): SelectOption => {
  const found = options.find((option) => option.id === id)
  if (found?.type !== 'select') {
    throw new Error(`missing select option ${id}`)
  }
  return found
}

describe('mcode session menus', () => {
  it('keeps one row per model, switches thinking only where both variants are listed, and passes effort menus through', () => {
    const rowsOf = (options: SessionConfigOption[]) =>
      acpSelectChoices(select(options, 'model')).map((choice) => [choice.value, choice.name])

    // M3 runs with thinking off: its off row folds into the thinking row and the switch reads off.
    const off = normalizeMcodeConfigOptions([modelSelect(M3_OFF)])
    expect(select(off, 'model').currentValue).toBe(M3_THINKING)
    expect(rowsOf(off)).toEqual([
      [M3_THINKING, 'MiniMax M3 (minimax)'],
      [FLASH, 'MiniMax M3.1 Flash'],
      [LEGACY_M3, 'MiniMax M3 (minimax-legacy)'],
      [LEGACY_M27, 'MiniMax M2.7']
    ])
    expect(select(off, 'thinkingEffort').currentValue).toBe('off')

    // A model mcode lists without an off row has no thinking switch to offer.
    const forcedOn = normalizeMcodeConfigOptions([modelSelect(LEGACY_M27)])
    expect(forcedOn).toHaveLength(1)
    expect(select(forcedOn, 'model').currentValue).toBe(LEGACY_M27)

    // The agent's own effort menu replaces the switch, exactly as reported.
    const flash = normalizeMcodeConfigOptions([modelSelect(FLASH), effortMenu])
    expect(flash).toHaveLength(2)
    expect(select(flash, 'thinkingEffort')).toEqual(effortMenu)
  })

  // mcode is set through its options: a model write changes the current row, an effort write the effort menu.
  const agentMenu = (current: string, effort: string): SessionConfigOption[] => [
    modelSelect(current),
    ...(current === FLASH ? [{ ...effortMenu, currentValue: effort }] : [])
  ]

  it.each([
    ['switches model, then thinking off', FLASH, M3_THINKING, 'off', M3_OFF],
    ['switches thinking off before any model pick', M3_THINKING, null, 'off', M3_OFF],
    ['picks an effort level', FLASH, FLASH, 'high', FLASH]
  ] as const)(
    'writes nothing to send once the picker %s',
    async (_case, startsOn, model, effort, expectedModel) => {
      const writes: string[] = []
      let current: string = startsOn
      let currentEffort = 'default'
      const connection: Pick<AcpStructuredConnection, 'setConfigOption' | 'setModel'> = {
        setConfigOption: async (configId: string, value: string) => {
          writes.push(`${configId}=${value}`)
          if (configId === 'model') {
            current = value
          } else {
            currentEffort = value
          }
          return { configOptions: agentMenu(current, currentEffort) }
        },
        setModel: async () => {
          throw new Error('mcode takes a model through its model option')
        }
      }
      const options = new AcpStructuredOptions(MCODE_DIALECT)
      options.adoptSession({ configOptions: agentMenu(current, currentEffort) }, 'new')
      // As the session adapter's setOption does.
      const setOption = async (key: string, value: string) => {
        const write = options.write(key, value)
        if (!write) {
          throw new Error(`mcode offers no session option named ${key}`)
        }
        options.notePick(key)
        await writeAcpSessionOption(connection, options, write, {
          agent: 'mcode',
          timeoutMs: 1000,
          key,
          value
        })
      }

      if (model) {
        await setOption('model', model)
      }
      await setOption('effort', effort)
      const expectedEffort = model === FLASH ? effort : 'default'
      expect([current, currentEffort]).toEqual([expectedModel, expectedEffort])

      writes.length = 0
      await applyAcpMessageOptions(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send path reads spec.agent, spec.dialect and the option state; it reaches session.connection only when an agent's own model command refuses, and mcode has none.
        {
          spec: { agent: 'mcode', dialect: MCODE_DIALECT },
          options
        } as unknown as AcpStructuredSession,
        { ...options.reported() },
        setOption,
        () => true
      )
      expect(writes).toEqual([])
      expect([current, currentEffort]).toEqual([expectedModel, expectedEffort])
    }
  )
})
