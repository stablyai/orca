import { ORCAD_ACTIVE_PROBE_SECTION_END } from '../orcad-active-readiness'

const SEPARATOR = `\nprintf '\\n%s\\n' ${ORCAD_ACTIVE_PROBE_SECTION_END}\n`

/** A fake host answers the folded active probe as a shell would: each section, then its marker line. */
export function answerActiveProbe(
  command: string,
  answer: (section: string) => string
): string | null {
  const sections = command.split(SEPARATOR)
  return sections.length === 2
    ? sections.map(answer).join(`\n\n${ORCAD_ACTIVE_PROBE_SECTION_END}\n`)
    : null
}
