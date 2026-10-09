import { describe, expect, it } from 'vitest'

import { GLOBAL_FLAGS } from './args'
import { formatCommandHelp } from './help'
import { COMMAND_SPECS } from './specs'

// Flags from #19016 that `--help` listed as a bare name with no description.
const DESCRIBED_FLAGS = ['environment', 'pairing-code', 'wait-submit', 'retry-request']

function spec(path: string): (typeof COMMAND_SPECS)[number] {
  const found = COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)
  if (!found) {
    throw new Error(`Missing command spec: ${path}`)
  }
  return found
}

function optionRow(help: string, flag: string): string {
  const row = help.split('\n').find((line) => new RegExp(`^  --${flag}(\\s|$)`).test(line))
  if (!row) {
    throw new Error(`No Options row for --${flag}`)
  }
  return row
}

// Why: the description may not start with `<`, so a placeholder-only row reads as undescribed.
function optionDescription(help: string, flag: string): string {
  const match = optionRow(help, flag).match(new RegExp(`^  --${flag}(?: <[^>]+>)?\\s+([^<\\s].*)$`))
  return match?.[1] ?? ''
}

describe('flag help text', () => {
  it('reads no description from a row that has only a value placeholder', () => {
    expect(optionDescription('  --environment <selector>', 'environment')).toBe('')
    expect(optionDescription('  --environment <selector>   ', 'environment')).toBe('')
    expect(optionDescription('  --environment', 'environment')).toBe('')
    expect(optionDescription('  --environment <selector> Saved id', 'environment')).toBe('Saved id')
  })

  it('describes every global flag', () => {
    const help = formatCommandHelp(spec('terminal list'))
    for (const flag of GLOBAL_FLAGS) {
      expect(optionDescription(help, flag), `--${flag}`).not.toBe('')
    }
  })

  it('describes --environment, --pairing-code, --wait-submit and --retry-request on terminal send', () => {
    const help = formatCommandHelp(spec('terminal send'))
    for (const flag of DESCRIBED_FLAGS) {
      expect(optionDescription(help, flag), `--${flag}`).not.toBe('')
    }
  })

  it('describes those flags on every command that accepts them', () => {
    // Why: passthrough commands forward argv untouched and render no Options block.
    for (const entry of COMMAND_SPECS.filter((item) => item.argumentMode !== 'passthrough')) {
      const help = formatCommandHelp(entry)
      for (const flag of DESCRIBED_FLAGS.filter((name) => entry.allowedFlags.includes(name))) {
        expect(optionDescription(help, flag), `${entry.path.join(' ')} --${flag}`).not.toBe('')
      }
    }
  })

  // Why: pinned verbatim, since a substring check still passes a row that states the opposite.
  it('states the behaviour each new description rests on', () => {
    const help = formatCommandHelp(spec('terminal send'))
    expect(optionDescription(help, 'environment')).toBe(
      'Connect using a saved environment id or name'
    )
    expect(optionDescription(help, 'pairing-code')).toBe(
      'Connect to a remote Orca runtime using an orca://pair?... code'
    )
    expect(optionDescription(help, 'wait-submit')).toBe(
      'Observe this accepted prompt without resending it (max 3600; needs --text --enter, no --interrupt)'
    )
    expect(optionDescription(help, 'retry-request')).toBe(
      'Resume the request Orca reported this ID for instead of starting a new one; idempotent'
    )
  })

  it('shows the value placeholder the usage lines use', () => {
    const help = formatCommandHelp(spec('terminal send'))
    expect(optionRow(help, 'environment')).toMatch(/^ {2}--environment <selector> /)
    expect(optionRow(help, 'pairing-code')).toMatch(/^ {2}--pairing-code <code> /)
    expect(optionRow(help, 'wait-submit')).toMatch(/^ {2}--wait-submit <seconds> /)
    expect(optionRow(help, 'retry-request')).toMatch(/^ {2}--retry-request <id> /)
  })

  // Why: on these commands the flag names the saved environment to act on, not a runtime to route to.
  it('gives environment add, show and rm their own meaning for the selection flags', () => {
    expect(optionDescription(formatCommandHelp(spec('environment add')), 'pairing-code')).toMatch(
      /to save/
    )
    expect(optionDescription(formatCommandHelp(spec('environment show')), 'environment')).toMatch(
      /to show/
    )
    expect(optionDescription(formatCommandHelp(spec('environment rm')), 'environment')).toMatch(
      /to remove/
    )
  })

  // Why: these commands never route, so the global "Connect ..." wording would be false here.
  it('says the unused selection flag is not used on environment add, show and rm', () => {
    expect(optionDescription(formatCommandHelp(spec('environment add')), 'environment')).toMatch(
      /^Not used/
    )
    for (const path of ['environment show', 'environment rm']) {
      expect(optionDescription(formatCommandHelp(spec(path)), 'pairing-code')).toMatch(/^Not used/)
    }
  })

  // Why: these handlers throw on either selection flag, so the global "Connect ..." row would be false.
  it('says the commands that reject the selection flags reject them', () => {
    const rejecting = [
      'environment list',
      'host list',
      'account add',
      'account list',
      'account select',
      'account rm',
      'artifacts list',
      'artifacts share',
      'artifacts update',
      'artifacts unshare',
      'artifacts delete',
      'profile state exports',
      'profile state rollback',
      'agent hooks prepare-codex',
      'agent hooks status',
      'agent hooks off',
      'agent hooks on'
    ]
    for (const path of rejecting) {
      const help = formatCommandHelp(spec(path))
      for (const flag of ['environment', 'pairing-code']) {
        expect(optionDescription(help, flag), `${path} --${flag}`).toBe(
          'Rejected; this command only runs on this machine'
        )
      }
    }
  })

  // Why: index.ts drops both selection flags for these commands without an error, so they run here.
  it('says the commands that ignore the selection flags do not use them', () => {
    for (const path of ['serve', 'vm recipe doctor', 'agent-context']) {
      const help = formatCommandHelp(spec(path))
      for (const flag of ['environment', 'pairing-code']) {
        expect(optionDescription(help, flag), `${path} --${flag}`).toBe(
          'Not used; this command only runs on this machine'
        )
      }
    }
  })

  // Why: --environment picks the managed server to act on and --pairing-code is dropped, so neither routes.
  it('gives the managed-server commands their own meaning for the selection flags', () => {
    const managed = [
      'environment status',
      'environment update',
      'environment rollback',
      'environment recover',
      'environment stop',
      'environment cancel-stop'
    ]
    for (const path of managed) {
      const help = formatCommandHelp(spec(path))
      expect(optionDescription(help, 'environment'), path).toBe(
        'Managed Orca server to act on (see orca environment list)'
      )
      expect(optionDescription(help, 'pairing-code'), path).toBe(
        'Not used; this command only runs on this machine'
      )
    }
  })
})
