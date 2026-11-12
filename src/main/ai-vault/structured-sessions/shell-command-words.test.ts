import { describe, expect, it } from 'vitest'
import { shellCommands } from './shell-command-words'

const commands = (text: string) => [...shellCommands(text)]

describe('shellCommands', () => {
  it('splits at separators glued to words, outside quotes only', () => {
    expect(commands(`cd /x&&a -s 1;b|c||d&e`)).toEqual([
      ['cd', '/x'],
      ['a', '-s', '1'],
      ['b'],
      ['c'],
      ['d'],
      ['e']
    ])
    expect(commands(`a "x;y" 'p|q&&r' z`)).toEqual([['a', 'x;y', 'p|q&&r', 'z']])
  })

  it('joins quoted runs into one word', () => {
    expect(commands(`a --session="s 1" -r='x'y 'it'"'"'s'`)).toEqual([
      ['a', '--session=s 1', '-r=xy', "it's"]
    ])
    expect(commands(`a "say \\"hi\\"" b`)).toEqual([['a', 'say \\"hi\\"', 'b']])
  })
})
