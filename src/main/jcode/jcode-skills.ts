// FEATURE B: discover + parse SKILL.md files so the jcode chat "/" menu can list
// real skills for the current project (like Claude Code's "/"). jcode headless
// has NO native skill loader — skills are just SKILL.md files (YAML frontmatter
// `name` + `description`/`when_to_use`, body = instructions). We scan three
// source classes, parse each, and on select inject the body into the prompt.
//
//   1. project-local  <projectRoot>/.claude/skills/<name>/SKILL.md
//   2. global         ~/.claude/skills/<name>/SKILL.md  (mostly symlinks)
//   3. plugin         <installPath>/skills/<name>/SKILL.md  (namespaced plugin:skill)
//
// For a REMOTE worktree the project-local skills live on the SSH host, so we read
// them over the same connection used for attachments; on failure we skip them and
// flag `degraded` so only global + plugin skills are returned.
import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { type BrowserWindow, ipcMain } from 'electron'
import { parse as parseYaml } from 'yaml'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { Store } from '../persistence'
import {
  JCODE_SKILLS_LIST_CHANNEL,
  type JcodeSkill,
  type JcodeSkillSource,
  type JcodeSkillsListPayload,
  type JcodeSkillsListResult
} from '../../shared/jcode-chat-types'
import { getLiveSshConnection, runRemoteCapture, type SshConnection } from './jcode-ssh-command'

/** Split a SKILL.md into its YAML frontmatter object + instruction body. A file
 *  with no leading `---` frontmatter yields empty frontmatter and the whole text
 *  as the body. Tolerates a missing closing fence by treating the rest as body. */
function parseSkillFile(
  content: string,
  dirName: string
): { name: string; description: string; body: string } {
  let frontmatter: Record<string, unknown> = {}
  let body = content
  if (content.startsWith('---')) {
    // First line is `---`; find the closing `---` on its own line.
    const closeMatch = content.match(/\n---[ \t]*(\r?\n|$)/)
    if (closeMatch && typeof closeMatch.index === 'number') {
      const yamlText = content.slice(3, closeMatch.index)
      body = content.slice(closeMatch.index + closeMatch[0].length)
      try {
        const parsed = parseYaml(yamlText)
        if (parsed && typeof parsed === 'object') {
          frontmatter = parsed as Record<string, unknown>
        }
      } catch {
        // Malformed frontmatter: fall back to the directory name + empty desc.
      }
    }
  }
  const name = asString(frontmatter.name) || dirName
  const description = asString(frontmatter.description) || asString(frontmatter.when_to_use) || ''
  return { name, description: collapse(description), body: body.trim() }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Collapse internal whitespace/newlines to single spaces for a one-line menu
 *  hint. The full multi-paragraph description would blow up the popover. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Read + parse one local SKILL.md, returning a JcodeSkill or null if unreadable. */
async function readLocalSkill(
  skillDir: string,
  dirName: string,
  source: JcodeSkillSource,
  pluginId?: string
): Promise<JcodeSkill | null> {
  try {
    const content = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    const { name, description, body } = parseSkillFile(content, dirName)
    return { name, description, body, source, ...(pluginId ? { pluginId } : {}) }
  } catch {
    return null
  }
}

/** Enumerate `<root>/<name>/SKILL.md` skills under a local skills root. Follows
 *  symlinks (the global ~/.claude/skills entries are mostly symlinks). Returns []
 *  when the root doesn't exist. */
async function scanLocalSkillsRoot(
  root: string,
  source: JcodeSkillSource,
  pluginId?: string
): Promise<JcodeSkill[]> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const skills = await Promise.all(
    entries.map(async (entry) => {
      const skillDir = join(root, entry)
      try {
        // stat (not lstat) so symlinked skill dirs are followed.
        const info = await stat(skillDir)
        if (!info.isDirectory()) {
          return null
        }
      } catch {
        return null
      }
      return readLocalSkill(skillDir, entry, source, pluginId)
    })
  )
  return skills.filter((s): s is JcodeSkill => s !== null)
}

/** Plugin skill dirs from ~/.claude/plugins/installed_plugins.json. Each plugin
 *  may expose `<installPath>/skills/<name>/SKILL.md`; names are namespaced as
 *  `plugin:skill` (mirroring Claude Code) to avoid collisions across plugins. */
async function scanPluginSkills(home: string): Promise<JcodeSkill[]> {
  let manifest: unknown
  try {
    const raw = await readFile(join(home, '.claude/plugins/installed_plugins.json'), 'utf8')
    manifest = JSON.parse(raw)
  } catch {
    return []
  }
  const plugins = (manifest as { plugins?: Record<string, unknown> })?.plugins
  if (!plugins || typeof plugins !== 'object') {
    return []
  }
  const out: JcodeSkill[] = []
  for (const [pluginId, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) {
      continue
    }
    // A plugin can have multiple installs; the first with a skills/ dir wins.
    for (const install of installs) {
      const installPath = (install as { installPath?: unknown })?.installPath
      if (typeof installPath !== 'string') {
        continue
      }
      const skills = await scanLocalSkillsRoot(join(installPath, 'skills'), 'plugin', pluginId)
      if (skills.length > 0) {
        // Namespace as plugin:skill. The plugin id is `name@marketplace`; use the
        // leading name segment for a compact, Claude-Code-like prefix.
        const prefix = pluginId.split('@')[0]
        for (const skill of skills) {
          out.push({ ...skill, name: `${prefix}:${skill.name}` })
        }
        break
      }
    }
  }
  return out
}

/** Read remote project-local `.claude/skills` over an SSH connection. Lists the
 *  skill dirs, then cats each SKILL.md, parsing the same way as local skills.
 *  Returns null when the directory can't be listed (no skills / unreadable). */
async function scanRemoteProjectSkills(
  conn: SshConnection,
  projectRoot: string
): Promise<JcodeSkill[] | null> {
  const root = `${projectRoot.replace(/\/+$/, '')}/.claude/skills`
  // List immediate subdirectories (skill names). -1p marks dirs with a trailing /.
  const listing = await runRemoteCapture(conn, `command ls -1Ap ${shellQuote(root)} 2>/dev/null`)
  if (listing === null) {
    return null
  }
  const dirNames = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('/') && line !== './' && line !== '../')
    .map((line) => line.slice(0, -1))
  const skills: JcodeSkill[] = []
  for (const dirName of dirNames) {
    const filePath = `${root}/${dirName}/SKILL.md`
    const content = await runRemoteCapture(conn, `cat ${shellQuote(filePath)} 2>/dev/null`)
    if (content === null) {
      continue
    }
    const { name, description, body } = parseSkillFile(content, dirName)
    skills.push({ name, description, body, source: 'project' })
  }
  return skills
}

/** POSIX single-quote escaping for a path argument in a remote command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Resolve a remote project's SSH connection + remote root from the worktree id,
 *  mirroring resolveRemoteExec in jcode-chat-session. Returns null for a local
 *  worktree (or when the workspace has no SSH connection). */
function resolveRemoteProject(
  store: Store | undefined,
  worktreeId: string | undefined
): { connectionId: string } | null {
  if (!store || typeof worktreeId !== 'string') {
    return null
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  const workspace = store.getFolderWorkspace(scope.folderWorkspaceId)
  if (workspace?.connectionId) {
    return { connectionId: workspace.connectionId }
  }
  return null
}

/** De-dupe skills by name with precedence project > global > plugin: an earlier
 *  source wins, so a project skill shadows a global one of the same name. */
function dedupeByName(groups: JcodeSkill[][]): JcodeSkill[] {
  const seen = new Set<string>()
  const out: JcodeSkill[] = []
  for (const group of groups) {
    for (const skill of group) {
      if (seen.has(skill.name)) {
        continue
      }
      seen.add(skill.name)
      out.push(skill)
    }
  }
  return out
}

/** Discover all skills available to the current chat pane. For a LOCAL worktree
 *  this scans <cwd>/.claude/skills + ~/.claude/skills + plugin skills. For a
 *  REMOTE worktree the project-local skills are read over SSH; if that fails the
 *  result is flagged `degraded` and only global + plugin skills are returned. */
export async function discoverSkills(
  payload: JcodeSkillsListPayload,
  store?: Store
): Promise<JcodeSkillsListResult> {
  const home = os.homedir()
  const cwd = payload.cwd?.trim()
  const remote = resolveRemoteProject(store, payload.worktreeId)

  // Global + plugin skills are always local to this machine.
  const [globalSkills, pluginSkills] = await Promise.all([
    scanLocalSkillsRoot(join(home, '.claude/skills'), 'global'),
    scanPluginSkills(home)
  ])

  let projectSkills: JcodeSkill[] = []
  let degraded = false
  if (remote) {
    // Remote worktree: read project-local skills over the live SSH connection.
    const conn = getLiveSshConnection(remote.connectionId)
    if (conn && cwd) {
      const remoteSkills = await scanRemoteProjectSkills(conn, cwd)
      if (remoteSkills === null) {
        degraded = true
      } else {
        projectSkills = remoteSkills
      }
    } else {
      // No live connection (or no cwd) — project-local skills are unavailable.
      degraded = true
    }
  } else if (cwd) {
    // Local worktree: scan the project root's .claude/skills.
    projectSkills = await scanLocalSkillsRoot(join(cwd, '.claude/skills'), 'project')
  }

  const skills = dedupeByName([projectSkills, globalSkills, pluginSkills])
  return { skills, ...(degraded ? { degraded: true } : {}) }
}

/** Look up a single skill's injectable body by name for the current pane. Used at
 *  send time to prepend the SKILL.md instructions to the prompt. Returns null if
 *  the named skill can't be found. */
export async function findSkillForInjection(
  skillName: string,
  payload: JcodeSkillsListPayload,
  store?: Store
): Promise<JcodeSkill | null> {
  const { skills } = await discoverSkills(payload, store)
  return skills.find((s) => s.name === skillName) ?? null
}

/** Build the prompt-injection block for a selected skill, prepended ahead of the
 *  user's message so the headless model follows the skill's instructions. */
export function buildSkillInjection(skill: JcodeSkill, userPrompt: string): string {
  const block = `Use the "${skill.name}" skill. Follow these instructions:\n\n${skill.body}`
  const base = userPrompt.trim()
  return `${block}\n\n---\n\n${base}`
}

/** Register the FEATURE B skills-list IPC handler (and its cleanup on window
 *  close). Kept here so the handler + its discovery logic live together and the
 *  chat-session module stays under budget. Safe to call on window recreate. */
export function registerJcodeSkillsHandler(mainWindow: BrowserWindow, store?: Store): void {
  ipcMain.removeHandler(JCODE_SKILLS_LIST_CHANNEL)
  ipcMain.handle(JCODE_SKILLS_LIST_CHANNEL, (event, raw: unknown) => {
    if (event.sender !== mainWindow.webContents) {
      return { skills: [] }
    }
    const payload = (raw ?? {}) as JcodeSkillsListPayload
    return discoverSkills({ cwd: payload.cwd, worktreeId: payload.worktreeId }, store)
  })
  mainWindow.on('closed', () => {
    ipcMain.removeHandler(JCODE_SKILLS_LIST_CHANNEL)
  })
}

/** Resolve the selected skill (if any) and PREPEND its SKILL.md body to the
 *  prompt. Re-discovers the skill from cwd + worktreeId so remote-project skills
 *  resolve over SSH. A missing/un-named skill is non-fatal: the prompt is
 *  returned unchanged so the turn still proceeds. */
export async function applySkillInjection(
  skillName: string | undefined,
  resolvedPrompt: string,
  context: { cwd?: string; worktreeId?: string },
  store?: Store
): Promise<string> {
  const name = skillName?.trim()
  if (!name) {
    return resolvedPrompt
  }
  try {
    const skill = await findSkillForInjection(
      name,
      { cwd: context.cwd, worktreeId: context.worktreeId },
      store
    )
    return skill ? buildSkillInjection(skill, resolvedPrompt) : resolvedPrompt
  } catch {
    return resolvedPrompt
  }
}
