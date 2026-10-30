import { describe, expect, it } from 'vitest'
import {
  PHONE_SETTING,
  describeSpeed,
  describeVoice,
  stepRate,
  voiceChoices,
  voicePickerOptions
} from './voice-choice'
import { translate } from '../i18n/mobile-i18n'
import type { NativeVoice, NativeVoiceList } from './voice-native-module'

function voice(name: string, language: string, extra: Partial<NativeVoice> = {}): NativeVoice {
  return { name, language, needsInternet: name.endsWith('-network'), installed: true, ...extra }
}

const LIST: NativeVoiceList = {
  language: 'pl-PL',
  defaultVoice: 'pl-pl-x-oda-local',
  voices: [
    voice('pl-pl-x-oda-network', 'pl-PL'),
    voice('en-us-x-iob-local', 'en-US'),
    voice('pl-pl-x-oda-local', 'pl-PL'),
    voice('pl-pl-x-bmg-local', 'pl-PL'),
    voice('pl-pl-x-zfg-local', 'pl-PL', { installed: false })
  ]
}

describe('voiceChoices', () => {
  it('lists installed offline voices in the reading language', () => {
    expect(voiceChoices(translate, LIST, null)).toEqual([
      { name: 'pl-pl-x-bmg-local', label: 'Voice 1', detail: '' },
      { name: 'pl-pl-x-oda-local', label: 'Voice 2', detail: 'Phone default' }
    ])
  })

  it('keeps the chosen voice listed even when online or in another language', () => {
    const online = voiceChoices(translate, LIST, 'pl-pl-x-oda-network')
    expect(online.find((c) => c.name === 'pl-pl-x-oda-network')).toEqual({
      name: 'pl-pl-x-oda-network',
      label: 'Voice 2',
      detail: 'Needs internet'
    })
    const names = voiceChoices(translate, LIST, 'en-us-x-iob-local').map((choice) => choice.name)
    expect(names).toContain('en-us-x-iob-local')
  })

  it('offers the phone setting first and describes the chosen voice', () => {
    const choices = voiceChoices(translate, LIST, null)
    expect(voicePickerOptions(translate, choices)[0]?.value).toBe(PHONE_SETTING)
    expect(describeVoice(translate, 'pl-pl-x-oda-local', choices)).toBe('Voice 2 · Phone default')
    expect(describeVoice(translate, 'pl-pl-x-bmg-local', choices)).toBe('Voice 1')
    expect(describeVoice(translate, null, choices)).toBe('Phone setting')
  })
})

describe('speed', () => {
  it('steps by 0.05 from the phone rate when none is chosen', () => {
    expect(stepRate(null, 1, 1)).toBe(1.05)
    expect(stepRate(null, 1.3, -1)).toBe(1.25)
    expect(stepRate(1.15, 1, -1)).toBe(1.1)
  })

  it('stays between 0.75 and 2', () => {
    expect(stepRate(0.75, 1, -1)).toBe(0.75)
    expect(stepRate(2, 1, 1)).toBe(2)
    expect(stepRate(null, 0.5, 1)).toBe(0.8)
  })

  it('describes the speed', () => {
    expect(describeSpeed(translate, null, 1)).toBe('Phone setting (1×)')
    expect(describeSpeed(translate, 1.15, 1)).toBe('1.15×')
    expect(describeSpeed(translate, 1, 1.3)).toBe('Normal (1×)')
  })
})
