/** Per-flag help for the skills commands, kept out of the shared help chain it would crowd. */
const SKILLS_FLAG_HELP: Record<string, Record<string, string>> = {
  'skills get': {
    full: '--full                 Print the full guide with bundled references',
    reference: '--reference <name>     Print one bundled reference by name',
    references: '--references           List the bundled reference names for a topic'
  },
  'skills install': {
    agent: '--agent <names>        Comma-separated install targets; default is detected agents'
  }
}

export function formatSkillsCommandFlagHelp(command: string, flag: string): string | undefined {
  return SKILLS_FLAG_HELP[command]?.[flag]
}
