import type { CommandSpec } from './args'
import { findCommandSpec, isCommandGroup, supportsBrowserPageFlag } from './args'
import { formatCommandFlagHelp } from './command-flag-help'

export { formatFlagHelp } from './command-flag-help'
import { unknownCommandData } from './command-suggestion'
import { ROOT_HELP_TEXT_PRIMARY } from './root-help-text-primary'
import { ROOT_HELP_TEXT_SECONDARY } from './root-help-text-secondary'

const ROOT_HELP_TEXT = [ROOT_HELP_TEXT_PRIMARY, ROOT_HELP_TEXT_SECONDARY].join('\n')

export function printHelp(specs: CommandSpec[], commandPath: string[] = []): void {
  const exactSpec = findCommandSpec(specs, commandPath)
  if (exactSpec) {
    console.log(formatCommandHelp(exactSpec))
    return
  }

  if (isCommandGroup(commandPath)) {
    console.log(formatGroupHelp(specs, commandPath[0]))
    return
  }

  if (commandPath.length > 0) {
    const { nextSteps } = unknownCommandData(specs, commandPath)
    const recovery = nextSteps.map((step) => `Next step: ${step}`).join('\n')
    console.log(`Unknown command: ${commandPath.join(' ')}${recovery ? `\n${recovery}` : ''}\n`)
  }

  console.log(ROOT_HELP_TEXT)
}

export function formatCommandHelp(spec: CommandSpec): string {
  const lines = [`orca ${spec.path.join(' ')}`, '', `Usage: ${spec.usage}`, '', spec.summary]
  const displayedFlags =
    spec.argumentMode === 'passthrough'
      ? []
      : supportsBrowserPageFlag(spec.path)
        ? [...spec.allowedFlags, 'page']
        : spec.allowedFlags

  if (displayedFlags.length > 0) {
    lines.push('', 'Options:')
    for (const flag of displayedFlags) {
      lines.push(`  ${formatCommandFlagHelp(flag, spec.path)}`)
    }
  }

  if (spec.notes && spec.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const note of spec.notes) {
      lines.push(`  ${note}`)
    }
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push('', 'Examples:')
    for (const example of spec.examples) {
      lines.push(`  $ ${example}`)
    }
  }

  return lines.join('\n')
}

export function formatGroupHelp(specs: CommandSpec[], group: string): string {
  const groupSpecs = specs.filter((spec) => spec.path[0] === group)
  const lines = [`orca ${group}`, '', `Usage: orca ${group} <command> [options]`, '', 'Commands:']
  for (const spec of groupSpecs) {
    lines.push(`  ${spec.path.slice(1).join(' ').padEnd(18)} ${spec.summary}`)
  }
  lines.push('', `Run \`orca ${group} <command> --help\` for command-specific usage.`)
  return lines.join('\n')
}
