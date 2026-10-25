import { describe, expect, it } from 'vitest'
import { commandProgramIndex, shellCommands } from './shell-command-words'

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

  it('keeps redirections inside the command', () => {
    expect(commands(`a 2>&1 >log b&>/dev/null c`)).toEqual([
      ['a', '2>&1', '>log', 'b&>/dev/null', 'c']
    ])
  })

  it('reads an unclosed quote as a character', () => {
    expect(commands(`a "b c; d`)).toEqual([['a', '"b', 'c'], ['d']])
  })

  it('continues a line after a continuation mark', () => {
    expect(commands('a \\\n -r 1\r\nb x`\r\ny')).toEqual([
      ['a', '-r', '1'],
      ['b', 'x', 'y']
    ])
  })

  it('stays linear on long and unbalanced texts', () => {
    const size = 2 * 1024 * 1024
    expect(commands('a'.repeat(size))[0]![0]).toHaveLength(size)
    expect(commands(`"${' \\"'.repeat(size / 3)}`)).toHaveLength(1)
    expect(commands(`'${" '".repeat(size / 2)}`)).toHaveLength(1)
  })
})

describe('commandProgramIndex', () => {
  it.each([
    [['claude', '-r', 'x'], 0],
    [['A=1', 'B=2', 'claude'], 2],
    [['env', '-i', 'A=1', 'claude'], 3],
    [['sudo', '-E', 'claude'], 2],
    [['pnpm', 'dlx', 'claude'], 2],
    [['nohup', 'claude'], 1],
    [['time', 'codex', 'resume', 'x'], 1],
    [['wsl.exe', '--', 'claude'], 2],
    [['/usr/bin/env', 'claude'], 1],
    [['A=1'], -1]
  ])('finds the program of %j at %i', (words, index) => {
    expect(commandProgramIndex(words)).toBe(index)
  })
})
