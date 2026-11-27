import { parse } from 'jsonc-parser'
import { expect, it } from 'vitest'
import { insertJsonProperties } from './json-property-insertion'
import { removeJsonProperties } from './json-property-removal'

it('edits the active object when a JSONC config repeats its server table', () => {
  const source = '{"mcpServers":{"old":{"command":"keep"}},"mcpServers":{"active":true}}'
  const inserted = insertJsonProperties(source, ['mcpServers'], [['orca', { command: 'orca' }]])!
  expect(parse(inserted)).toEqual({ mcpServers: { active: true, orca: { command: 'orca' } } })
  expect(removeJsonProperties(inserted, ['mcpServers'], ['orca'])).toBe(source)
})

it('removes the active property without deleting its shadowed user value', () => {
  const source = '{"mcpServers":{"bridge":{"command":"user"},"bridge":{"command":"orca"}}}'
  expect(removeJsonProperties(source, ['mcpServers'], ['bridge'])).toBe(
    '{"mcpServers":{"bridge":{"command":"user"}}}'
  )
})
