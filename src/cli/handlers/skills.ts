import { spawn } from 'node:child_process'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { delimiter, dirname } from 'node:path'
import { getRepeatedStringFlag } from '../flags'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { detectCommandsInInstallDirs } from '../../shared/local-agent-install-dir-detection'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from '../../shared/tui-agent-detection-commands'
import {
  getSpawnArgsForWindows,
  UnsafeWindowsBatchArgumentsError
} from '../../shared/windows-batch-spawn'
import { isSkillsCliAgentKeyShaped, toSkillsCliAgentKeys } from '../../shared/skills-cli-agent-keys'
import {
  buildAgentFeatureSkillInstallArgs,
  buildAgentFeatureSkillUpdateArgs
} from '../../shared/agent-feature-install-commands'

type BundledSkillGuide = {
  name: string
  description: string
  markdown: string
  fullMarkdown: string
  aliases: readonly string[]
}

function canonicalGuides(guides: readonly BundledSkillGuide[]): BundledSkillGuide[] {
  return [...guides].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )
}

function requireTopic(
  flags: Map<string, string | boolean>,
  guides: BundledSkillGuide[]
): BundledSkillGuide {
  const availableTopics = guides.map((guide) => guide.name).join(', ')
  const topic = flags.get('topic')
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Missing skill topic. Available topics: ${availableTopics}`
    )
  }
  // Why: installed stubs may retain an old topic forever, so aliases and canonical
  // names share one lookup table instead of being treated as transient CLI aliases.
  const guideByTopic = new Map<string, BundledSkillGuide>(
    guides.flatMap((guide) => [guide.name, ...guide.aliases].map((name) => [name, guide]))
  )
  const guide = guideByTopic.get(topic)
  if (!guide) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown skill topic "${topic}". Available topics: ${availableTopics}`
    )
  }
  return guide
}

function writeStdout(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`)
}

function resolveSelectedSkillNames(
  flags: Map<string, string | boolean>,
  guides: BundledSkillGuide[]
): string[] {
  const requestedSkills = getRepeatedStringFlag(flags, 'skill')
  const selectAll = flags.get('all') === true
  if (flags.has('skill') && requestedSkills.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --skill')
  }
  if (selectAll && requestedSkills.length > 0) {
    throw new RuntimeClientError('invalid_argument', 'Use either --all or --skill, not both.')
  }
  if (!selectAll && requestedSkills.length === 0) {
    return []
  }
  if (selectAll) {
    return guides.map((guide) => guide.name)
  }
  const availableTopics = guides.map((guide) => guide.name).join(', ')
  const guideByTopic = new Map<string, BundledSkillGuide>(
    guides.flatMap((guide) => [guide.name, ...guide.aliases].map((name) => [name, guide]))
  )
  const canonicalNames = new Set<string>()
  for (const requested of requestedSkills) {
    const guide = guideByTopic.get(requested)
    if (!guide) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown skill "${requested}". Available skills: ${availableTopics}`
      )
    }
    canonicalNames.add(guide.name)
  }
  return [...canonicalNames].sort()
}

/** PATH with the resolved npx's own directory first, so its `env node` shebang resolves. */
function buildNpxPath(resolvedNpx: string): string {
  // Why: resolveCliCommand falls back to the bare name when it finds nothing, and
  // dirname('npx') is '.', so prepending it blindly would run ./npx out of the
  // caller's checkout instead of reporting that npx is missing.
  const own = dirname(resolvedNpx)
  const existing = process.env.PATH ?? process.env.Path ?? ''
  // Why: every version manager ships node beside npx in the same bin directory,
  // so the resolved sibling is all the child needs to run npx's shebang.
  return [own === '.' ? '' : own, existing].filter(Boolean).join(delimiter)
}

function runNpxSkills(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // Why: a bare PATH lookup misses nvm/fnm/volta installs, and hardcoding
    // `npx.cmd` both misses `npx.exe` shims and hides a missing npx behind
    // cmd.exe's own exit code, so the friendly error below never fires.
    const resolved = resolveCliCommand('npx')
    let spawnCmd: string
    let spawnArgs: string[]
    try {
      ;({ spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolved, args))
    } catch (error) {
      // Why: the guard rejects cmd metacharacters, and only the resolved npx
      // path can carry them here — a username like `A&B` puts them in it.
      if (!(error instanceof UnsafeWindowsBatchArgumentsError)) {
        reject(error)
        return
      }
      reject(
        new RuntimeClientError(
          'invalid_environment',
          `Cannot run npx from "${resolved}": the path contains characters cmd.exe would ` +
            'reinterpret. Install Node.js somewhere without & | < > ^ " % ! in the path.'
        )
      )
      return
    }
    // Why: npx is an `#!/usr/bin/env node` script, so resolving it off PATH is
    // not enough — without node alongside it the child exits 127 with no
    // 'error' event and the message below never fires.
    const child = spawn(spawnCmd, spawnArgs, {
      stdio: 'inherit',
      env: { ...process.env, PATH: buildNpxPath(resolved) }
    })
    // Why: a missing npx/Node on a headless host surfaces as a raw spawn ENOENT;
    // wrap it so the CLI reports an actionable message like every other failure here.
    child.once('error', (error) => {
      const detail = error instanceof Error ? error.message : String(error)
      reject(
        new RuntimeClientError(
          'invalid_environment',
          `Could not run npx: ${detail}. Install Node.js and ensure npx is on PATH.`
        )
      )
    })
    child.once('exit', (code, signal) => {
      resolve(typeof code === 'number' ? code : signal ? 1 : 0)
    })
  })
}

type SkillMutationVerb = 'install' | 'update'

/** Agents Orca can see on this host, as `skills --agent` keys. */
function detectSkillsCliAgentKeys(): string[] {
  const runtime = process.platform
  const probes = getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, runtime)
  const detected = resolveDetectedTuiAgentIds(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    detectCommandsInInstallDirs(probes),
    runtime
  )
  return detected.length === 0 ? [] : toSkillsCliAgentKeys(detected)
}

function resolveInstallAgentKeys(flags: Map<string, string | boolean>): string[] {
  const requested = flags.get('agent')
  if (flags.has('agent') && typeof requested !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
  }
  if (typeof requested === 'string') {
    // Why: one comma-separated value rather than a repeatable flag — `agent` is a
    // single-value flag on other commands and the repeatable set is process-wide,
    // so making it repeatable here would change how those parse a second --agent.
    const keys = [
      ...new Set(
        requested
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      )
    ]
    // Why: a value like "," parses to nothing. Falling through to detection would
    // be surprising, and emitting no --agent would restore the all-agents install.
    if (keys.length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
    }
    const unusable = keys.find((key) => !isSkillsCliAgentKeyShaped(key))
    if (unusable !== undefined) {
      // Why: the skills CLI drops a value starting with `-`, which leaves it with
      // no target and installs into every agent it knows.
      throw new RuntimeClientError(
        'invalid_argument',
        `Invalid --agent value "${unusable}". Pass agent names such as claude-code, ` +
          'codex, or universal.'
      )
    }
    return keys
  }
  const detected = detectSkillsCliAgentKeys()
  if (detected.length > 0) {
    return detected
  }
  // Why: without --agent, `skills add -y` falls into its own zero-detected branch
  // and installs into every agent it knows (~75), creating config directories for
  // agents this host does not have. Say so instead.
  throw new RuntimeClientError(
    'invalid_environment',
    'No coding agent detected on this host, so there is no install target. Pass ' +
      '--agent <name>[,<name>...] to choose targets explicitly — --agent universal ' +
      'writes only the shared .agents/skills directory that Orca reads.'
  )
}

function buildNpxSkillsArgs(
  verb: SkillMutationVerb,
  skillNames: string[],
  global: boolean,
  agents: string[]
): string[] {
  const skillArgs =
    verb === 'install'
      ? buildAgentFeatureSkillInstallArgs(skillNames, { global, yes: true, agents })
      : buildAgentFeatureSkillUpdateArgs(skillNames, { global, yes: true })
  // Why: a cold package cache makes bare `npx` prompt before it will fetch
  // `skills`, which strands an unattended host just like the picker does.
  return ['--yes', ...skillArgs]
}

/** Render the exact argv a real run spawns, so --dry-run can never drift from it. */
function formatNpxCommand(args: string[]): string {
  return `npx ${args.join(' ')}`
}

function formatSkillSelectionHelp(verb: SkillMutationVerb, skillNames: string[]): string {
  return [
    `Choose one or more skills to ${verb}:`,
    ...skillNames.map((name) => `  ${name}`),
    '',
    `Usage: orca skills ${verb} --skill <name> [--skill <name> ...]`,
    `   or: orca skills ${verb} --all`
  ].join('\n')
}

function createSkillMutationHandler(verb: SkillMutationVerb): CommandHandler {
  return async ({ flags, json }) => {
    // Why: keep the large generated table off the eager handler registry path.
    const { BUNDLED_SKILL_GUIDES } = await import('../bundled-skill-guides.js')
    const guides = canonicalGuides(BUNDLED_SKILL_GUIDES)
    const skillNames = resolveSelectedSkillNames(flags, guides)

    if (skillNames.length === 0) {
      const names = guides.map((guide) => guide.name)
      writeStdout(
        json
          ? JSON.stringify({ availableSkills: names }, null, 2)
          : formatSkillSelectionHelp(verb, names)
      )
      return
    }

    // Why: this runs before target resolution because the answer belongs to the
    // other machine — agents detected here would be the wrong host's, and a host
    // that detects none would hide the forwarding problem behind that error.
    if (process.env.ORCA_CLI_CWD) {
      throw new RuntimeClientError(
        'invalid_environment',
        `orca skills ${verb} writes to the machine that runs it, but this shell forwards ` +
          `orca to the Orca host. Run the same orca skills ${verb} command on the machine ` +
          "you want it on, where it can detect that host's agents."
      )
    }

    const global = flags.get('local') !== true
    // Why: install scopes its targets; update only refreshes what is already placed.
    const agents = verb === 'install' ? resolveInstallAgentKeys(flags) : []
    const npxArgs = buildNpxSkillsArgs(verb, skillNames, global, agents)
    const command = formatNpxCommand(npxArgs)
    const dryRun = flags.get('dry-run') === true

    if (dryRun) {
      writeStdout(
        json
          ? JSON.stringify({ command, skills: skillNames, global, executed: false }, null, 2)
          : `${command}\n\nRerun without --dry-run to ${verb} now.`
      )
      return
    }

    if (json) {
      // Why: a real run inherits npx's own stdout so progress stays visible live;
      // that stream is not JSON, so --json can't be honored here.
      throw new RuntimeClientError(
        'invalid_argument',
        `orca skills ${verb} --json only supports --dry-run. Real ${verb}s stream ` +
          "npx's own output, which isn't JSON."
      )
    }

    // Why: stdio is inherited for the child below, so this status line must go to
    // stderr — stdout is npx's own output, not this command's JSON channel.
    process.stderr.write(`Running: ${command}\n`)
    process.exitCode = await runNpxSkills(npxArgs)
  }
}

export const SKILL_HANDLERS: Record<string, CommandHandler> = {
  'skills list': async ({ json }) => {
    // Why: the embedded guide table is large, so unrelated CLI commands must not
    // pay its module-load and parse cost during startup.
    const { BUNDLED_SKILL_GUIDES } = await import('../bundled-skill-guides.js')
    const guides = canonicalGuides(BUNDLED_SKILL_GUIDES)
    // Why: generated registry order is not a user-facing contract, while stable
    // canonical sorting keeps agent-visible output reproducible across builds.
    const topics = guides.map((guide) => ({
      name: guide.name,
      description: guide.description.replace(/\s+/g, ' ').trim()
    }))
    writeStdout(
      json
        ? JSON.stringify({ topics }, null, 2)
        : topics.map((topic) => `${topic.name}: ${topic.description}`).join('\n')
    )
  },
  'skills get': async ({ flags, json }) => {
    // Why: keep the large generated table off the eager handler registry path.
    const { BUNDLED_SKILL_GUIDES } = await import('../bundled-skill-guides.js')
    const guides = canonicalGuides(BUNDLED_SKILL_GUIDES)
    const guide = requireTopic(flags, guides)
    const full = flags.has('full')
    const markdown = full ? guide.fullMarkdown : guide.markdown
    writeStdout(json ? JSON.stringify({ name: guide.name, full, markdown }, null, 2) : markdown)
  },
  'skills install': createSkillMutationHandler('install'),
  'skills update': createSkillMutationHandler('update')
}
