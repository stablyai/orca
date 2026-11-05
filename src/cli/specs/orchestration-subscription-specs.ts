import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const ORCHESTRATION_SUBSCRIPTION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'subscribe'],
    summary: 'Opt this terminal into idle mailbox pointer submission'
  },
  {
    path: ['orchestration', 'unsubscribe'],
    summary: 'Stop mailbox pointer submission for this terminal'
  },
  {
    path: ['orchestration', 'subscription', 'status'],
    summary: 'Inspect this terminal mailbox subscription and latest wake result'
  }
].map(({ path, summary }) => ({
  path,
  summary,
  usage: `orca ${path.join(' ')}${path.at(-1) === 'status' ? '' : ' [--retry-request <id>]'} [--json]`,
  allowedFlags: path.at(-1) === 'status' ? [...GLOBAL_FLAGS] : [...GLOBAL_FLAGS, 'retry-request']
}))
