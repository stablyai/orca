import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'

export type SlashCommand = {
  name: string
  description: string
  source: 'project' | 'user' | 'skill'
}

function frontmatterDescription(content: string): string {
  // Why: command/skill files carry a YAML frontmatter with a description line.
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  if (m) {
    const d = m[1].match(/^description:\s*(.+)$/m)
    if (d) {
      return d[1].trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return ''
}

async function scanCommandsDir(dir: string, source: 'project' | 'user'): Promise<SlashCommand[]> {
  const out: SlashCommand[] = []
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Why: Claude Code namespaces subdirectory commands as /dir:name.
      const nested = await scanCommandsDir(full, source)
      out.push(...nested.map((c) => ({ ...c, name: `${entry.name}:${c.name}` })))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = await fs.readFile(full, 'utf8').catch(() => '')
      out.push({
        name: entry.name.slice(0, -3),
        description: frontmatterDescription(content),
        source
      })
    }
  }
  return out
}

async function scanSkillsDir(dir: string): Promise<SlashCommand[]> {
  const out: SlashCommand[] = []
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const skillFile = path.join(dir, entry.name, 'SKILL.md')
    const content = await fs.readFile(skillFile, 'utf8').catch(() => null)
    if (content !== null) {
      out.push({
        name: entry.name,
        description: frontmatterDescription(content),
        source: 'skill'
      })
    }
  }
  return out
}

export async function listSlashCommands(cwd: string, home?: string): Promise<SlashCommand[]> {
  const homeDir = home ?? os.homedir()
  const [project, user, skills] = await Promise.all([
    scanCommandsDir(path.join(cwd, '.claude', 'commands'), 'project'),
    scanCommandsDir(path.join(homeDir, '.claude', 'commands'), 'user'),
    scanSkillsDir(path.join(homeDir, '.claude', 'skills'))
  ])
  // Project commands shadow user ones; skills come last; dedupe by name.
  const seen = new Set<string>()
  const out: SlashCommand[] = []
  for (const cmd of [...project, ...user, ...skills]) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name)
      out.push(cmd)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
