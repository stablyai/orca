import { expect, it } from 'vitest'
import { parsePtyOwnershipModelRestoreMetadata as parse } from './pty-ownership-transfer-model-restore-metadata'

it('preserves unknown keyboard flags distinctly from known zero and null cwd', () => {
  expect(parse({ version: 1 })).toEqual({ version: 1 })
  expect(parse({ version: 1, kittyKeyboardFlags: 0, cwd: null })).toEqual({
    version: 1,
    kittyKeyboardFlags: 0,
    cwd: null
  })
})

it.each([
  { version: 2 },
  { kittyKeyboardFlags: -1 },
  { kittyKeyboardFlags: '5' },
  { cwd: 5 },
  { lastTitle: null },
  { pendingEscapeTailAnsi: 7 },
  { terminalOwner: 'agent' },
  { oscLinks: [{ uri: 'link' }] }
])('refuses malformed restore metadata: %j', (patch) => {
  expect(() => parse({ version: 1, ...patch })).toThrow('metadata_invalid')
})

it('copies link metadata without retaining mutable caller aliases', () => {
  const value = {
    version: 1,
    oscLinks: [{ row: 0, startCol: 0, endCol: 4, uri: 'https://example.com' }]
  }
  const parsed = parse(value)
  value.oscLinks[0].uri = 'changed'
  expect(parsed.oscLinks?.[0].uri).toBe('https://example.com')
})
