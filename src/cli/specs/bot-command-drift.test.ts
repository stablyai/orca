// Every command and flag a bot is taught (its preamble's Tools and Rules, and the bots reference)
// must parse against the real CLI, so a rename in the CLI fails here instead of in a bot's turn.
import { describe, expect, it } from 'vitest'
import { BOT_FIRST_RUN_RULES, BOT_ORCA_CLI, buildBotPreamble } from '../../main/bots/bot-preamble'
import { BUNDLED_SKILL_GUIDES } from '../skills/bundled-skill-guides'
import {
  effectiveAllowedFlags,
  findCommandSpec,
  isCommandGroup,
  normalizeCommandPositionals,
  parseArgs,
  validateCommandAndFlags
} from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import { HANDLER_COMMAND_KEYS } from '../dispatch/dispatch'
import { COMMAND_SPECS } from './index'

type Taught = { source: string; line: string; commands: string[][]; flags: string[] }

const COMMAND_PATHS = COMMAND_SPECS.flatMap(specPaths)

function reference(guide: string, name: string): string {
  const found = BUNDLED_SKILL_GUIDES.find((entry) => entry.name === guide)?.references
  const markdown = found?.find((entry) => entry.name === name)?.markdown
  if (!markdown) {
    throw new Error(`missing bundled reference ${guide}/${name}`)
  }
  return markdown
}

/** Splits like a shell would, keeping quoted text as one argument. */
function words(text: string): string[] {
  return [...text.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((match) =>
    match[0].replace(/^["']|["']$/g, '')
  )
}

/** One taught example as argv lists: `<x>` is a value, `[...]` is included, `a|b` is each of a and b. */
function argvs(example: string): string[][] {
  const tokens = words(
    example
      .replace(/\\\|/g, '|')
      .replace(/<[^>]*>/g, 'value')
      .replace(/[[\]]/g, ' ')
      .replace(/\.\.\./g, ' ')
  )
  let all: string[][] = [[]]
  // A bare `|` separates alternative flags of one command (`--text x | --react y`).
  for (const token of tokens.filter((word) => word !== '|')) {
    const choices = !token.startsWith('-') && token.includes('|') ? token.split('|') : [token]
    all = all.flatMap((argv) => choices.map((choice) => [...argv, choice]))
  }
  return all
}

/** The commands and loose flags each line of a text teaches. */
function taught(source: string, text: string, cli: string): Taught[] {
  return text.split('\n').flatMap((line) => {
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)
    const commands = spans
      .filter((span) => span.startsWith(`${cli} `))
      .flatMap((span) => argvs(span.slice(cli.length + 1)))
    // Flags named in prose or in a span of their own belong to the line's commands.
    const prose = line.replace(/`[^`]*`/g, (span) => (span.startsWith('`--') ? span : ' '))
    const flags = [...prose.matchAll(/(?:^|[\s`(,])--([a-z][a-z0-9-]*)/g)].map((match) => match[1]!)
    return commands.length || flags.length ? [{ source, line, commands, flags }] : []
  })
}

function parse(argv: string[]) {
  return normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, COMMAND_PATHS, COMMAND_SPECS))
}

/** Why the CLI would refuse this argv, or null when it parses and has a handler. */
function refusal(argv: string[]): string | null {
  const parsed = parse(argv)
  // Prose names a top-level group ("`orca linear` acts as your owner") without running it; any
  // deeper path taught bare, like `bot tools`, must be a command of its own.
  if (
    parsed.flags.size === 0 &&
    parsed.commandPath.length === 1 &&
    isCommandGroup(COMMAND_SPECS, parsed.commandPath)
  ) {
    return null
  }
  try {
    validateCommandAndFlags(COMMAND_SPECS, parsed)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  const spec = findCommandSpec(COMMAND_SPECS, parsed.commandPath)!
  return HANDLER_COMMAND_KEYS.has(spec.path.join(' '))
    ? null
    : `no handler for ${spec.path.join(' ')}`
}

const PREAMBLES = {
  preamble: buildBotPreamble({ name: 'Scout', agent: 'claude', soul: null, memory: null }),
  'first-run rules': BOT_FIRST_RUN_RULES
}

const TAUGHT: Taught[] = [
  ...Object.entries(PREAMBLES).flatMap(([source, text]) => taught(source, text, BOT_ORCA_CLI)),
  ...taught('orca-cli/bots.md', reference('orca-cli', 'bots'), 'ORCA'),
  ...taught('orca-cli/google-setup.md', reference('orca-cli', 'google-setup'), 'ORCA'),
  ...taught('orca-cli/bot-import.md', reference('orca-cli', 'bot-import'), 'ORCA')
]

describe('commands a bot is taught', () => {
  it('finds the commands it checks in every source', () => {
    // A change to how a source names the CLI would otherwise make this pass on nothing.
    const anchors: Record<string, string[]> = {
      preamble: ['repo list', 'bot connectors', 'bot reply', 'slack post', 'linear comment add'],
      'first-run rules': ['bot connectors'],
      'orca-cli/bots.md': ['webhooks calls', 'bot tools connect', 'slack check', 'bot reply'],
      'orca-cli/google-setup.md': ['bot google-setup need-user', 'tab create', 'wait'],
      'orca-cli/bot-import.md': ['bot import plan', 'bot import done', 'automations create']
    }
    for (const [source, expected] of Object.entries(anchors)) {
      const commands = TAUGHT.filter((entry) => entry.source === source).flatMap((entry) =>
        entry.commands.map((argv) => argv.join(' '))
      )
      for (const command of expected) {
        expect(
          commands.some((taught) => taught.startsWith(command)),
          `${source}: ${command}`
        ).toBe(true)
      }
    }
  })

  it('parses every taught command against the CLI, with a handler behind it', () => {
    const refused = TAUGHT.flatMap((entry) =>
      entry.commands.flatMap((argv) => {
        const why = refusal(argv)
        return why ? [`${entry.source}: orca ${argv.join(' ')}: ${why}`] : []
      })
    )
    expect(refused).toEqual([])
  })

  it('names only flags that a command on the same line accepts', () => {
    const allFlags = new Set(
      TAUGHT.flatMap((entry) => entry.commands).flatMap((argv) => {
        const spec = findCommandSpec(COMMAND_SPECS, parse(argv).commandPath)
        return spec ? effectiveAllowedFlags(spec) : []
      })
    )
    const unknown = TAUGHT.flatMap((entry) => {
      const accepted = new Set(
        entry.commands.flatMap((argv) => {
          const spec = findCommandSpec(COMMAND_SPECS, parse(argv).commandPath)
          return spec ? effectiveAllowedFlags(spec) : []
        })
      )
      // A flag in a line without a command (e.g. "an `--on` edit") must belong to some taught command.
      const known = entry.commands.length ? accepted : allFlags
      return entry.flags
        .filter((flag) => !known.has(flag))
        .map((flag) => `${entry.source}: --${flag} in "${entry.line.trim().slice(0, 120)}"`)
    })
    expect(unknown).toEqual([])
  })

  it('points only at guides and references the CLI serves', () => {
    const missing = TAUGHT.flatMap((entry) =>
      entry.commands.flatMap((argv) => {
        const parsed = parse(argv)
        if (parsed.commandPath.join(' ') !== 'skills get') {
          return []
        }
        const name = String(parsed.flags.get('topic'))
        const guide = BUNDLED_SKILL_GUIDES.find(
          (entry) => entry.name === name || entry.aliases.some((alias) => alias === name)
        )
        const wanted = parsed.flags.get('reference')
        const served =
          guide &&
          (typeof wanted !== 'string' ||
            guide.references.some((reference) => reference.name === wanted))
        return served ? [] : [`${entry.source}: orca ${argv.join(' ')}`]
      })
    )
    expect(missing).toEqual([])
  })
})
