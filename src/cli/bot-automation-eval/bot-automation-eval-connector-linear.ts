// The stand-in's Linear writes as connector actions: a set on an issue and a post with a title making
// one, kept in the run (EvalHostState.linearRun) so later reads and searches show them.
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import { hasLinear, type PlaceView } from './bot-automation-eval-connector-places'
import type { EvalHostState } from './bot-automation-eval-host'
import { linearIssue, linearTeam } from './bot-automation-eval-linear'
import { createLinear, setLinear } from './bot-automation-eval-linear-writes'
import type { StandInIo } from '../bot-orchestration-eval/bot-orchestration-eval-orca'

/** A Linear issue's fields changed as the bot asked. */
export function setIssue(
  state: EvalHostState,
  ref: string,
  args: ConnectorActionArgs,
  io: StandInIo,
  params: Record<string, unknown>
): unknown {
  const issue = hasLinear(state) ? linearIssue(ref, state.linearRun) : undefined
  if (!issue || !args.fields) {
    return {
      ok: false,
      refusal: issue ? 'invalid_args' : 'not_found',
      message: issue
        ? 'set needs a field to change.'
        : "The bot can't see that issue in Linear, or it doesn't exist."
    }
  }
  const { answer, change } = setLinear(issue, args.fields, state.linearRun)
  if (change) {
    io.record({
      kind: 'write',
      method: 'connector.set',
      params,
      result: { target: answer.result.target.ref, state: answer.result.facts.state.name }
    })
    const changes = state.linearRun?.changes
    state.linearRun = {
      ...state.linearRun,
      changes: { ...changes, [issue.identifier]: { ...changes?.[issue.identifier], ...change } }
    }
    io.save(state)
  }
  return answer
}

/** A new Linear issue in the team a post with a title names; any other place is refused as the cloud does. */
export function createIssue(
  state: EvalHostState,
  place: PlaceView,
  args: ConnectorActionArgs,
  io: StandInIo,
  params: Record<string, unknown>
): unknown {
  if (!place.ref.startsWith('linear:') || !hasLinear(state)) {
    const source = place.ref.split(':')[0]
    return {
      ok: false,
      refusal: 'unsupported',
      message: `Creating isn't available in ${source} yet.`
    }
  }
  const team = linearTeam(place.ref)
  if (!team || !args.title || !args.postId) {
    return {
      ok: false,
      refusal: 'invalid_args',
      message: 'A new Linear issue goes in a team: pass its key, name or ref, and a title.'
    }
  }
  const parent = args.parent ? linearIssue(args.parent, state.linearRun) : undefined
  if (args.parent && !parent) {
    return {
      ok: false,
      refusal: 'not_found',
      message: "The bot can't see that issue in Linear, or it doesn't exist."
    }
  }
  const { answer, made } = createLinear(
    team,
    {
      key: `eval:${state.bots[0]?.id}:${args.postId}`,
      title: args.title,
      ...(args.text ? { text: args.text } : {}),
      ...(parent ? { parent } : {}),
      ...(args.fields ? { fields: args.fields } : {})
    },
    state.linearRun
  )
  if (made) {
    io.record({ kind: 'write', method: 'connector.post', params, result: { target: place.ref } })
    state.linearRun = { ...state.linearRun, created: [...(state.linearRun?.created ?? []), made] }
    io.save(state)
  }
  return answer
}
