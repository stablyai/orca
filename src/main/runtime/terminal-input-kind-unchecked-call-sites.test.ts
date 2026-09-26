import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree } from '../../shared/source-scan/source-tree-scan'
import {
  findCallsMissingArgument,
  type RequiredCallArgument
} from '../../shared/source-scan/call-argument-scan'

/**
 * Every PTY write names its input kind, and the compiler enforces that everywhere except the
 * runtime files split out with `@ts-nocheck`. There a missing kind would compile and silently
 * record nothing, so this scan is the ratchet for them.
 */
const MAIN_ROOT = resolve(__dirname, '..')

const namesInputKind = (literal: string): boolean => /\binputKind\b|\.\.\./.test(literal)
const kindAt = (index: number, receiver?: RegExp): RequiredCallArgument => ({
  index,
  ...(receiver ? { receiver } : {}),
  acceptsObjectLiteral: namesInputKind
})
const CONTROLLER = /ptyController\??\s*$/

const KIND_ARGUMENT_BY_METHOD: Record<string, RequiredCallArgument> = {
  write: kindAt(2, CONTROLLER),
  writeWithSettlement: kindAt(2, CONTROLLER),
  sendTerminal: kindAt(2),
  sendTerminalAgentPrompt: kindAt(2),
  writeTerminalAction: kindAt(3),
  writeTerminalInputChunks: kindAt(2),
  writeTerminalAgentPrompt: kindAt(4),
  writeAction: kindAt(3),
  writeChunks: kindAt(2)
}

const uncheckedSources = scanSourceTree(MAIN_ROOT).filter((file) =>
  file.source.startsWith('// @ts-nocheck')
)

describe('PTY write call sites the compiler cannot check', () => {
  it('scans the unchecked runtime files that write to a PTY', () => {
    expect(uncheckedSources.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining([
        'runtime/orca-runtime-deliver-pending-messages.ts',
        'runtime/orca-runtime-create-pty-headless-terminal-state.ts',
        'runtime/orca-runtime-write-terminal-agent-prompt.ts'
      ])
    )
  })

  it('finds a write, prompt or send that leaves out its kind', () => {
    const planted = [
      '',
      'this.ptyController?.write(ptyId, reply)',
      "this.ptyController.write(ptyId, '\\r', 'launch')",
      "await this.sendTerminal(handle, { text: 'a, b' }, { beforeWrite })",
      'await this.sendTerminalAgentPrompt(handle, prompt, { ...options })',
      'other.write(ptyId, data)'
    ].join('\n')

    expect(findCallsMissingArgument(planted, KIND_ARGUMENT_BY_METHOD)).toEqual([
      '2: .write(ptyId, reply)',
      "4: .sendTerminal(handle, { text: 'a, b' }, { beforeWrite })"
    ])
  })

  it('passes an input kind at every write', () => {
    const missing = uncheckedSources.flatMap((file) =>
      findCallsMissingArgument(file.source, KIND_ARGUMENT_BY_METHOD).map(
        (site) => `${file.relativePath}:${site}`
      )
    )

    expect(missing).toEqual([])
  })
})
