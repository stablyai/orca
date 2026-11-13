import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { findOptionOccurrence } from '../../../shared/command-option-occurrence'
import {
  compactRecipeOptions,
  KIMI_VALUE_OPTIONS
} from '../../../shared/source-control/ai/generation/commit-message-generation-options'
import type { CommitMessagePlan } from '../../../shared/source-control/ai/generation/commit-message-plan'
const object = z.record(z.string(), z.unknown())

export async function prepareKimiTextTaskPolicy(
  plan: CommitMessagePlan,
  readRecipe: (file: string) => Promise<string>
) {
  if (findOptionOccurrence(plan.args, ['--agent'], true, KIMI_VALUE_OPTIONS, 0, 'required')) {
    throw new Error('Kimi named profiles cannot apply the text task tool policy')
  }
  const file = findOptionOccurrence(
    plan.args,
    ['--agent-file'],
    true,
    KIMI_VALUE_OPTIONS,
    0,
    'required'
  )
  let content =
    '---\nname: orca-text-generation\ndescription: Text generation for Orca\ntools: []\n---\n${base_prompt}\n'
  if (file) {
    if (!file.value) {
      throw new Error('Missing text task agent file')
    }
    const original = await readRecipe(file.value)
    const frontmatter =
      /^(?:\uFEFF)?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)([\s\S]*)$/.exec(
        original
      )
    if (!frontmatter) {
      throw new Error('Invalid text task agent file')
    }
    const profile = object.parse(parseYaml(frontmatter[1]))
    if (profile.name == null || (typeof profile.name === 'string' && !profile.name.trim())) {
      profile.name = (file.value.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '')
    }
    profile.tools = []
    delete profile.disallowedTools
    content = `---\n${stringifyYaml(profile)}---\n${frontmatter[2]}`
  }
  const args = compactRecipeOptions(plan.args, ['--agent-file'], KIMI_VALUE_OPTIONS)
  args.push('--agent-file', '{text-task-profile}')
  return {
    ...plan,
    args,
    taskFiles: [{ name: 'text-task-profile.md', content, argIndex: args.length - 1 }]
  }
}
