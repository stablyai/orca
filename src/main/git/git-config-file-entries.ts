// Minimal reader for one Git config file's text: no includes, no multi-line values. Callers that
// need more than these rules can express must ask Git instead.

// A section header may be followed on the same line by further headers and then one assignment
// (`[core] sparseCheckout = true` is legal git config); the value runs to end of line, so at most
// one assignment can share a line and the last header before it decides the section.
const GIT_CONFIG_SECTION_HEADER = /^\[\s*([A-Za-z0-9.-]+)(\s+"(?:[^"\\]|\\.)*")?\s*\]/
const GIT_CONFIG_ASSIGNMENT = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/

export type GitConfigFileEntry = {
  /** Lowercased. */
  section: string
  /** The raw quoted subsection, or undefined for a plain `[section]`. */
  subsection: string | undefined
  /** Lowercased. */
  key: string
  /** Undefined for a valueless key (`sparseCheckout` alone), which Git reads as boolean true. */
  value: string | undefined
}

export function readGitConfigFileEntries(configContent: string): GitConfigFileEntry[] {
  const entries: GitConfigFileEntry[] = []
  let section = ''
  let subsection: string | undefined
  for (const rawLine of configContent.split(/\r?\n/)) {
    let rest = stripGitConfigComment(rawLine).trim()
    for (
      let header = rest.match(GIT_CONFIG_SECTION_HEADER);
      header;
      header = rest.match(GIT_CONFIG_SECTION_HEADER)
    ) {
      section = header[1].toLowerCase()
      subsection = header[2]
      rest = rest.slice(header[0].length).trim()
    }
    if (!section || rest.length === 0) {
      continue
    }
    const assignment = rest.match(GIT_CONFIG_ASSIGNMENT)
    if (assignment) {
      entries.push({ section, subsection, key: assignment[1].toLowerCase(), value: assignment[2] })
    }
  }
  return entries
}

// `section` and `key` must be lowercase: git config names are case-insensitive. Only the last
// assignment wins, and a `[core "subsection"]` header is intentionally not treated as `[core]`.
export function parseGitConfigFlag(
  configContent: string,
  section: string,
  key: string
): boolean | undefined {
  return readGitConfigFlag(readGitConfigFileEntries(configContent), section, key)
}

export function readGitConfigFlag(
  entries: readonly GitConfigFileEntry[],
  section: string,
  key: string
): boolean | undefined {
  const value = readGitConfigValue(entries, section, key)
  return value === null ? undefined : parseGitConfigBoolean(value)
}

/** The last plain-section value for `section.key`; null when unset, undefined when valueless. */
export function readGitConfigValue(
  entries: readonly GitConfigFileEntry[],
  section: string,
  key: string
): string | undefined | null {
  let value: string | undefined | null = null
  for (const entry of entries) {
    if (entry.section === section && entry.subsection === undefined && entry.key === key) {
      value = entry.value
    }
  }
  return value
}

// Drop a trailing `#`/`;` comment that is not inside a double-quoted value.
function stripGitConfigComment(line: string): string {
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"' && line[index - 1] !== '\\') {
      inQuotes = !inQuotes
    } else if ((char === '#' || char === ';') && !inQuotes) {
      return line.slice(0, index)
    }
  }
  return line
}

// Git treats a valueless boolean (`sparseCheckout` with no `=`) as true and only true/yes/on/1 as
// true otherwise; everything else (including the disable-written `false`) is false.
export function parseGitConfigBoolean(raw: string | undefined): boolean {
  if (raw === undefined) {
    return true
  }
  const value = raw
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .toLowerCase()
  return value === 'true' || value === 'yes' || value === 'on' || value === '1'
}
