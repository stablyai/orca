import { afterEach, expect, it, vi } from 'vitest'
import capture from '../../../src/shared/__fixtures__/omp-native-commands.json'
import * as catalog from '../../../src/shared/native-chat/input/native-chat-slash-commands'
import type { NativeChatPickerItem } from '../../../src/shared/native-chat/input/native-chat-picker-items'
import { deriveComposerAutocomplete } from '../../../src/shared/native-chat-composer-autocomplete'
import {
  mobileComposerCatalog,
  boundedMenuItems
} from './native-chat/composer/mobile-native-chat-composer-menu'

afterEach(() => vi.restoreAllMocks())

it('bounds native OMP picker name reads at N/10N while preserving first duplicate descriptions', () => {
  const reportedSkills = catalog.sessionReportedSkills
  let visits = 0
  vi.spyOn(catalog, 'sessionReportedSkills').mockImplementation((...args) =>
    reportedSkills(...args).map((skill) => ({
      ...skill,
      get name() {
        visits += 1
        return skill.name
      }
    }))
  )
  const native = capture.enabled.availableCommands.find((row) => row.name === 'skill:plan')!
  for (const surface of ['desktop', 'mobile'] as const) {
    const counts = [10, 100].map((size) => {
      const reported = [
        ...Array.from({ length: size }, (_, i) => ({
          name: `${native.name}-${i}`,
          kind: 'command' as const,
          description: i === 0 ? undefined : native.description
        })),
        { name: `${native.name}-0`, kind: 'command' as const, description: 'Later duplicate' },
        { name: `${native.name}-1`, kind: 'command' as const, description: 'Later duplicate' }
      ]
      visits = 0
      let rows: NativeChatPickerItem[]
      if (surface === 'desktop') {
        const picker = deriveComposerAutocomplete(
          '/plan',
          5,
          catalog.sessionSlashCommandSuggestions('omp', reported),
          [],
          null,
          { status: 'ready', skills: [] },
          null,
          catalog.sessionReportedSkills(reported, 'omp')
        )
        expect(picker.mode).toBe('slash')
        if (picker.mode !== 'slash') {
          throw new Error('Missing native picker')
        }
        rows = picker.items
      } else {
        const menu = mobileComposerCatalog({
          agent: 'omp',
          structured: { reported, conversationCommands: [] }
        })
        const picker = deriveComposerAutocomplete(
          '/plan',
          5,
          menu.commands,
          menu.discovery.skills,
          menu.profile,
          menu.discovery,
          null,
          menu.sessionSkills
        )
        expect(picker.mode).toBe('slash')
        rows = picker.mode === 'slash' ? boundedMenuItems(picker.items) : []
      }
      const skills = rows.filter((row) => row.kind === 'skill')
      expect(skills).toHaveLength(Math.min(size, surface === 'desktop' ? 50 : 10))
      expect(new Set(skills.map((row) => row.token)).size).toBe(skills.length)
      expect(skills.find((row) => row.token === '/skill:plan-0')?.description).toBeNull()
      expect(skills.find((row) => row.token === '/skill:plan-1')?.description).toBe(
        native.description
      )
      expect(visits).toBeGreaterThanOrEqual(reported.length)
      expect(visits).toBeLessThanOrEqual(10 * reported.length)
      return visits
    })
    expect(counts[1]).toBeLessThanOrEqual(12 * counts[0]!)
  }
})
