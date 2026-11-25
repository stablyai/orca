import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import type { CommandHandler } from '../dispatch/dispatch'
import { rejectRemoteSelectionFlags } from '../dispatch/remote-selection-flag-rejection'
import { isLocalEnvironmentSelector } from '../hosts/local-environment-selector'
import { RuntimeClientError } from '../runtime/connection/types'
import { getDefaultUserDataPath } from '../runtime/profile/metadata'
import { getRepeatedStringFlag } from '../arguments/flags'
import { writeStdoutLine } from '../output/stdout-line'
import { skillsCliAgentAliases } from './skills-cli-agent-aliases'
import { loadCanonicalGuides, type BundledSkillGuide } from './bundled-skill-guide-table'
import {
  collapseHomePath,
  skillBackupDirectory
} from '../../shared/skills/bundled/bundled-skill-locations'
import { summarizeBundledSkillOutcomes } from '../../shared/skills/bundled/bundled-skill-summary'
import {
  describeOutcomeOpLines,
  describePlan,
  hasReplaceableLeave
} from './bundled-skill-install-lines'
import {
  isSkillInstallProviderId,
  SKILL_INSTALL_PROVIDERS,
  type SkillInstallProviderId
} from '../../shared/skills/installation/skill-install-providers'
import { SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT } from '../../shared/skills/installation/skills-cli-agent-keys'
import {
  installBundledSkills,
  previewBundledSkillInstall
} from '../../main/skills/bundled-skill-install/bundled-skill-installation'
import { localBundledSkillInput } from '../../main/skills/bundled-skill-install/bundled-skill-local-host'

export type SkillMutationVerb = 'install' | 'update'

const SHARED_FOLDER_ONLY = 'universal'

// Preserve --agent keys forwarded to the external skills CLI by earlier releases.
const SKILLS_CLI_KEY_ALIASES = skillsCliAgentAliases(SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT)

/** `undefined` means detect; `[]` is `--agent universal`, the shared folder alone. */
function requestedAgents(
  flags: Map<string, string | boolean>
): SkillInstallProviderId[] | undefined {
  const requested = flags.get('agent')
  if (flags.has('agent') && typeof requested !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
  }
  if (typeof requested !== 'string') {
    return undefined
  }
  // Other commands treat --agent as a single-value flag, so accept multiple providers with commas.
  const values = requested
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (values.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
  }
  const agents = new Set<SkillInstallProviderId>()
  for (const value of values) {
    if (value === SHARED_FOLDER_ONLY) {
      continue
    }
    const agent = isSkillInstallProviderId(value) ? value : SKILLS_CLI_KEY_ALIASES.get(value)
    if (!agent) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown --agent value "${value}". Use one or more of: ` +
          `${SKILL_INSTALL_PROVIDERS.map((provider) => provider.id).join(', ')}, ` +
          `or ${SHARED_FOLDER_ONLY} for the shared .agents/skills folder alone.`
      )
    }
    agents.add(agent)
  }
  return [...agents]
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
  if (selectAll) {
    return guides.map((guide) => guide.name)
  }
  const guideByTopic = new Map<string, BundledSkillGuide>(
    guides.flatMap((guide) => [guide.name, ...guide.aliases].map((name) => [name, guide]))
  )
  const canonicalNames = new Set<string>()
  for (const requested of requestedSkills) {
    const guide = guideByTopic.get(requested)
    if (!guide) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown skill "${requested}". Available skills: ${guides.map((g) => g.name).join(', ')}`
      )
    }
    canonicalNames.add(guide.name)
  }
  return [...canonicalNames].sort()
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

async function workspaceDirectory(): Promise<string> {
  // Match the real-path spelling used to deduplicate planner targets.
  return realpath(process.cwd())
}

function rejectNonlocalSkillMutationFlags(
  flags: ReadonlyMap<string, string | boolean>,
  verb: SkillMutationVerb
): void {
  const nonlocalFlags = new Map(flags)
  // `--environment local` is this machine, which is the only place this command writes.
  if (isLocalEnvironmentSelector(nonlocalFlags.get('environment'))) {
    nonlocalFlags.delete('environment')
  }
  rejectRemoteSelectionFlags(
    nonlocalFlags,
    `orca skills ${verb}; it writes on the machine that runs it`,
    {
      nextSteps: [
        `Run \`orca skills ${verb}\` on the machine whose agents need the skills.`,
        'Drop the flag to write on this machine.'
      ]
    }
  )
}

export function createSkillMutationHandler(verb: SkillMutationVerb): CommandHandler {
  return async ({ flags, json }) => {
    rejectNonlocalSkillMutationFlags(flags, verb)
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

    // Local agent detection would target the wrong machine for a bridged invocation.
    if (process.env.ORCA_CLI_CWD) {
      throw new RuntimeClientError(
        'invalid_environment',
        `orca skills ${verb} writes to the machine that runs it, but this shell forwards ` +
          `orca to the Orca host. Run the same orca skills ${verb} command on the machine ` +
          "you want it on, where it can detect that host's agents."
      )
    }

    const local = flags.get('local') === true
    const input = await localBundledSkillInput({
      userDataPath: getDefaultUserDataPath(),
      destination: local
        ? {
            scope: 'workspace',
            homeDirectory: homedir(),
            workspaceDirectory: await workspaceDirectory()
          }
        : { scope: 'global', homeDirectory: homedir() },
      agents: requestedAgents(flags),
      selection: {
        names: skillNames,
        ...(flags.get('force') === true ? { force: 'all' as const } : {}),
        installedOnly: verb === 'update'
      }
    })
    const plan = await previewBundledSkillInstall(input)
    const planned = new Set(plan.skills.map((entry) => entry.name))
    // --all is allowed to skip bundled skills that are not installed.
    const notInstalled =
      verb === 'update' && flags.get('all') !== true
        ? skillNames.filter((name) => !planned.has(name))
        : []
    const notInstalledLines = notInstalled.map(
      (name) =>
        `${name}: not installed, so skipped. Install it with: orca skills install --skill ${name}`
    )
    // Why the home's own separator: path.join would mix them for a home from another OS.
    const backupFolder = collapseHomePath(
      skillBackupDirectory(plan.homeDirectory),
      plan.homeDirectory
    )
    const forceHint = hasReplaceableLeave(plan)
      ? [
          '',
          'Rerun with --force to replace skipped copies where possible. ' +
            `Orca moves each copy it replaces, including any extra files, to ${backupFolder} first.`
        ]
      : []

    if (flags.has('dry-run')) {
      writeStdoutLine(
        json
          ? JSON.stringify(
              {
                executed: false,
                scope: plan.scope,
                planDigest: plan.planDigest,
                plan,
                notInstalled
              },
              null,
              2
            )
          : [
              ...describePlan(plan),
              ...notInstalledLines,
              ...forceHint,
              '',
              `Plan digest: ${plan.planDigest}`,
              `Rerun without --dry-run to ${verb} now.`
            ].join('\n')
      )
      return
    }

    const result = await installBundledSkills(input, plan.planDigest)
    const summary = summarizeBundledSkillOutcomes(result)
    process.exitCode = summary.exitCode
    if (json) {
      writeStdoutLine(
        JSON.stringify(
          {
            executed: true,
            scope: plan.scope,
            planDigest: plan.planDigest,
            plan,
            result,
            summary,
            notInstalled
          },
          null,
          2
        )
      )
      return
    }
    const lines = result.skills.flatMap((outcome, index) => [
      `${outcome.name}: ${summary.skills[index].line}`,
      ...outcome.ops.flatMap((op) =>
        describeOutcomeOpLines(
          outcome.name,
          op,
          backupFolder,
          summary.skills[index].text === 'Needs attention'
        )
      )
    ])
    if (lines.length === 0 && notInstalledLines.length === 0) {
      lines.push('No Orca skills are installed here, so there is nothing to update.')
    }
    writeStdoutLine([...lines, ...notInstalledLines, ...forceHint].join('\n'))
  }
}
