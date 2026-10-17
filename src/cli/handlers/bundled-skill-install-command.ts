import { homedir } from 'node:os'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getDefaultUserDataPath } from '../runtime/metadata'
import { writeStdoutLine } from '../stdout-line'
import { getRepeatedStringFlag } from '../flags'
import { loadCanonicalGuides, type BundledSkillGuide } from './bundled-skill-guide-table'
import { detectCommandsInInstallDirs } from '../../shared/local-agent-install-dir-detection'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from '../../shared/tui-agent-detection-commands'
import {
  bundledSkillLeftLocations,
  bundledSkillVerdict,
  type BundledSkillLeaveReason,
  type BundledSkillLocationAction,
  type BundledSkillPlan
} from '../../shared/skill-freshness'
import {
  describeBundledSkillInstallResult,
  installBundledOrcaSkills,
  planBundledOrcaSkills,
  resolveEnvironmentSkillProviderRoots,
  type BundledOrcaSkillInstallInput
} from '../../main/skills/bundled-orca-skill-cli-entry'

export type SkillMutationVerb = 'install' | 'update'

// Why: receipts carry no host meaning for Orca's own skills; this only labels who wrote one.
const CLI_HOST_IDENTITY = 'orca-cli'
const SHARED_FOLDER_ONLY = 'universal'
const NOTHING_TO_UPDATE =
  'No Orca skills are installed here, so there is nothing to update. ' +
  'Install one with: orca skills install --skill <name>'
// Why: earlier releases took the skills CLI's key for Claude Code; scripts still pass it.
const PROVIDER_ALIASES: Readonly<Record<string, string>> = { 'claude-code': 'claude' }

function detectLocalAgents(): string[] {
  const runtime = process.platform
  const probes = getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, runtime)
  return resolveDetectedTuiAgentIds(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    detectCommandsInInstallDirs(probes),
    runtime
  )
}

function resolveProviders(flags: Map<string, string | boolean>): readonly string[] {
  const requested = flags.get('agent')
  if (flags.has('agent') && typeof requested !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
  }
  if (typeof requested !== 'string') {
    return detectLocalAgents()
  }
  // Why one comma-separated value: `agent` is a single-value flag on other commands.
  const values = requested
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (values.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
  }
  const known = new Set<string>(SKILL_INSTALL_PROVIDERS.map((provider) => provider.id))
  const providers = new Set<string>()
  for (const value of values) {
    const provider = PROVIDER_ALIASES[value] ?? value
    if (provider === SHARED_FOLDER_ONLY) {
      continue
    }
    if (!known.has(provider)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown --agent value "${value}". Use one or more of: ${[...known].join(', ')}, ` +
          `or ${SHARED_FOLDER_ONLY} for the shared .agents/skills directory alone.`
      )
    }
    providers.add(provider)
  }
  return [...providers]
}

function installInput(flags: Map<string, string | boolean>): BundledOrcaSkillInstallInput {
  const scope = flags.get('local') === true ? 'workspace' : 'global'
  const workspaceDirectory = scope === 'workspace' ? process.cwd() : undefined
  return {
    scope,
    homeDirectory: homedir(),
    workspaceDirectory,
    // Why the app's userData: its receipts are what let the app recognise these installs.
    orcaStateDirectory: getDefaultUserDataPath(),
    detectedProviders: resolveProviders(flags),
    providerRootOverrides: scope === 'global' ? resolveEnvironmentSkillProviderRoots() : {},
    hostIdentity: CLI_HOST_IDENTITY,
    destinationIdentity:
      scope === 'global'
        ? `global:${CLI_HOST_IDENTITY}`
        : `workspace:${CLI_HOST_IDENTITY}:${workspaceDirectory}`,
    discardLocalChanges: flags.get('force') === true,
    // Why a no-op: discovery's per-skill scan line is app diagnostics, not CLI output.
    discoveryLog: () => {}
  }
}

const LEAVE_REASON_TEXT: Readonly<Record<BundledSkillLeaveReason, string>> = {
  'local-changes': 'it has changes Orca did not make',
  'not-installed-by-orca': 'Orca did not install it',
  'link-not-managed': 'it is a link Orca does not manage',
  'name-in-use': 'another file or folder already uses this name',
  'read-only': 'its folder is read-only',
  unreadable: 'Orca could not read it'
}

const PLAN_STEP_TEXT: Partial<Record<BundledSkillLocationAction, string>> = {
  install: 'would install',
  update: 'would update',
  link: 'would link',
  replace: 'would replace'
}

function describePlan(plan: BundledSkillPlan): string {
  const steps = plan.locations.flatMap((location) => {
    const step = PLAN_STEP_TEXT[location.action]
    return step ? [`${step} ${location.path}`] : []
  })
  const shared = plan.locations.find((location) => location.role === 'shared')
  const left = bundledSkillLeftLocations(plan).map(
    (location) =>
      `${plan.name}: would leave ${location.path}, ${LEAVE_REASON_TEXT[location.reason ?? 'unreadable']}`
  )
  const head =
    steps.length > 0
      ? [`${plan.name}: ${steps.join('; ')}`]
      : left.length === 0
        ? [`${plan.name}: already up to date (${shared?.path ?? plan.name})`]
        : []
  return [...head, ...left].join('\n')
}

// Why: only a copy the user can tell Orca to overwrite; a link or a colliding name stays.
function forceWouldHelp(plans: readonly BundledSkillPlan[]): boolean {
  return plans.some((plan) =>
    bundledSkillLeftLocations(plan).some(
      (location) =>
        location.role === 'shared' &&
        (location.reason === 'local-changes' || location.reason === 'not-installed-by-orca')
    )
  )
}

function describeNotInstalled(name: string): string {
  return `${name}: not installed, so not updated. Install it with: orca skills install --skill ${name}`
}

function landed(result: SkillInstallResult): boolean {
  return (
    result.status === 'installed' || result.status === 'updated' || result.status === 'unchanged'
  )
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

function selectsAll(flags: Map<string, string | boolean>): boolean {
  return flags.get('all') === true
}

function resolveSelectedSkillNames(
  flags: Map<string, string | boolean>,
  guides: BundledSkillGuide[]
): string[] {
  const requestedSkills = getRepeatedStringFlag(flags, 'skill')
  const selectAll = selectsAll(flags)
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

export function createSkillMutationHandler(verb: SkillMutationVerb): CommandHandler {
  return async ({ flags, json }) => {
    const guides = await loadCanonicalGuides()
    const skillNames = resolveSelectedSkillNames(flags, guides)

    if (skillNames.length === 0) {
      const names = guides.map((guide) => guide.name)
      writeStdoutLine(
        json
          ? JSON.stringify({ availableSkills: names }, null, 2)
          : formatSkillSelectionHelp(verb, names)
      )
      return
    }

    // Why: this runs before target resolution because the answer belongs to the
    // other machine — agents detected here would be the wrong host's.
    if (process.env.ORCA_CLI_CWD) {
      throw new RuntimeClientError(
        'invalid_environment',
        `orca skills ${verb} writes to the machine that runs it, but this shell forwards ` +
          `orca to the Orca host. Run the same orca skills ${verb} command on the machine ` +
          "you want it on, where it can detect that host's agents."
      )
    }

    const input = installInput(flags)
    const global = input.scope === 'global'
    const dryRun = flags.get('dry-run') === true
    const plans = verb === 'update' || dryRun ? await planBundledOrcaSkills(skillNames, input) : []
    const verdictOf = new Map(plans.map((plan) => [plan.name, bundledSkillVerdict(plan)]))
    // Why: update runs the same verdict the app's Update skills dialog shows; install adds.
    const runNames =
      verb === 'update'
        ? skillNames.filter((name) => {
            const verdict = verdictOf.get(name)
            return verdict === 'update' || verdict === 'current'
          })
        : skillNames
    const leftAsIs =
      verb === 'update' ? plans.filter((plan) => verdictOf.get(plan.name) === 'attention') : []
    const notInstalled =
      verb === 'update' ? skillNames.filter((name) => verdictOf.get(name) === 'absent') : []
    // Why: --all names every bundled skill, so skipping the absent ones is expected there.
    const notInstalledLines = selectsAll(flags) ? [] : notInstalled.map(describeNotInstalled)
    if (notInstalledLines.length > 0 || leftAsIs.length > 0) {
      process.exitCode = 1
    }
    const extraJson = {
      ...(notInstalled.length > 0 ? { notInstalled } : {}),
      ...(leftAsIs.length > 0 ? { leftAsIs } : {})
    }
    const forceHint = forceWouldHelp(leftAsIs)
      ? ['', 'Rerun with --force to replace a copy that has local changes.']
      : []

    if (dryRun) {
      const shown = plans.filter(
        (plan) => verb === 'install' || verdictOf.get(plan.name) !== 'absent'
      )
      writeStdoutLine(
        json
          ? JSON.stringify(
              { skills: runNames, global, executed: false, plan: shown, ...extraJson },
              null,
              2
            )
          : shown.length === 0 && notInstalledLines.length === 0
            ? NOTHING_TO_UPDATE
            : `${[...shown.map(describePlan), ...notInstalledLines].join('\n')}\n\n` +
              `Rerun without --dry-run to ${verb} now.`
      )
      return
    }

    if (runNames.length === 0 && leftAsIs.length === 0 && !json) {
      writeStdoutLine(
        notInstalledLines.length > 0 ? notInstalledLines.join('\n') : NOTHING_TO_UPDATE
      )
      return
    }
    const results = runNames.length > 0 ? await installBundledOrcaSkills(runNames, input) : []
    if (results.some((result) => !landed(result))) {
      process.exitCode = 1
    }
    if (json) {
      writeStdoutLine(
        JSON.stringify({ skills: runNames, global, executed: true, results, ...extraJson }, null, 2)
      )
      return
    }
    const lines = [
      ...results.map(describeBundledSkillInstallResult),
      ...leftAsIs.map(describePlan),
      ...notInstalledLines
    ]
    const replaceable = results.some(
      (result) => result.conflict?.kind === 'modified' || result.conflict?.kind === 'unowned'
    )
    if (replaceable || forceHint.length > 0) {
      lines.push('', 'Rerun with --force to replace a copy that has local changes.')
    }
    writeStdoutLine(lines.join('\n'))
  }
}
