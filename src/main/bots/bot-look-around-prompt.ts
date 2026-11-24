// What a look-around run is asked: find what waits on the owner and suggest next steps, reading only.
import { BOT_QUIET_MARKER } from '../../shared/bot-quiet-result'
import { SUGGESTION_LIMITS } from '../../shared/bots/bot-look-around'
import { BOT_ORCA_CLI } from './bot-preamble'
import type { lookHistory } from './bot-look-around-state'

const DEFAULT_FOCUS =
  'Anything waiting on your owner: reviews asked of them, failing checks on their work, questions put to them, follow-ups they promised.'

function titles(heading: string, list: readonly string[]): string[] {
  return list.length === 0 ? [] : [heading, ...list.map((title) => `- ${title}`)]
}

/** How every look's prompt opens; older looks are known by it. */
export const LOOK_AROUND_PROMPT_OPENING = 'Look around: find what is waiting on your owner'

export function lookAroundPrompt(input: {
  focus: string
  history: ReturnType<typeof lookHistory>
}): string {
  const cli = BOT_ORCA_CLI
  return [
    `${LOOK_AROUND_PROMPT_OPENING} and suggest up to ${SUGGESTION_LIMITS.perRun} next steps for their Suggestions list.`,
    '',
    'This run only reads. Read files, run read-only commands (`gh pr view|list|checks|diff`, `gh issue|run view|list`, `git log|show|diff|status|rev-parse|ls-files`, ' +
      `\`${cli} bot connectors|list|chats\`, \`${cli} bot item list|show\`, \`${cli} bot work list\`, \`${cli} slack find|read|check\`, \`${cli} linear issue|search|list-issues\`, \`${cli} automations list|show\`, \`${cli} repo list\`, \`${cli} worktree ps\`), and suggest. ` +
      'You may chain reads with `;`, `&&` or `||` and end one with `2>&1`; pipes, `$(...)` and other redirects are refused. Anything else is refused; do not retry it, suggest it instead. Do not edit MEMORY.md or any other file.',
    '',
    `Look for: ${input.focus.trim() || DEFAULT_FOCUS}`,
    '',
    `Also look at \`${cli} worktree ps --since 7d\` for workspaces with an open agent that fit your purpose and the focus above, and aren't already under a bot. Judge the work from the agents' recent activity, group related workspaces, and suggest taking them over only when you can name a concrete next step and what your owner could stop keeping track of. Check \`${cli} bot list\` for other bots' purposes and point to the right bot when appropriate. Put the offer in Suggestions with \`bot suggest\`; its ask should name the bot and workspace IDs to hand over.`,
    '',
    ...titles(
      'Still listed (suggest again with the same title only if still true):',
      input.history.open
    ),
    '',
    ...titles('They started these recently, so they act on this kind:', input.history.started),
    '',
    ...titles(
      'They dismissed these: never suggest them again, in any wording:',
      input.history.dismissed
    ),
    '',
    `For each suggestion run \`${cli} bot suggest --title '...' --why '...' --ask '...' [--link <url>]\`:`,
    `- title: what to do, under ${SUGGESTION_LIMITS.title} characters.`,
    '- why: one sentence on why now.',
    '- ask: the message your owner would send you to do it, written as them.',
    '- link: the thread, issue or pull request it is about.',
    'Quote each value in straight single quotes, on one line, with no apostrophe, double quote or curly quote inside; other quoting is refused. Suggest only things with a concrete next step; if nothing is worth it, suggest nothing.',
    '',
    `When done, end with ${BOT_QUIET_MARKER}; one short line for your owner may come before it.`
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
}
